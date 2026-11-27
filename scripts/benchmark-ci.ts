import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopProfile, renderingEnvironment } from '../src/capture/policy.ts';
import { readImageSize } from '../src/compare/images.ts';
import { RunQueue } from '../src/execution/queue.ts';
import { initializeLocalOperator } from '../src/execution/runtime.ts';
import { Worker } from '../src/execution/worker.ts';
import { digestOf, DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines } from '../src/persistence/baselines.ts';
import { createApp } from '../src/server/app.ts';
import { testDatabase } from '../tests/support/postgres.ts';

const database = await testDatabase();
const queue = new RunQueue(database.pool);
const artifacts = new DiskArtifacts(join(database.directory, 'artifacts'));
const baselines = new Baselines(database.pool, artifacts);
const worker = new Worker(queue, baselines, artifacts);
const controller = new AbortController();
let app: ReturnType<typeof createApp> | undefined;
let processing: Promise<void> | undefined;

async function frame(file: string) {
  const bytes = await readFile(`web/assets/${file}.png`);
  const size = readImageSize(bytes);
  return {
    route: '/analytics',
    key: 'desktop',
    identity: 'a'.repeat(64),
    image: bytes.toString('base64'),
    metadata: {
      ...desktopProfile,
      ...renderingEnvironment,
      ...size,
      browserVersion: 'fixture',
      mode: 'full-page',
      blockedRequests: 0,
      sha256: digestOf(bytes),
      sizeBytes: bytes.length,
      durationMs: 0,
    },
  };
}

try {
  const operator = await initializeLocalOperator(database.pool);
  const project = await queue.createProject(operator, 'Benchmark');
  const scope = { ...operator, projectId: project.id };
  const credential = await queue.ci.issue(scope, 'Benchmark worker', 'main');
  const token = randomBytes(32).toString('base64url');
  app = createApp(false, { token, operator, queue, baselines, artifacts });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const [original, changed] = await Promise.all([
    frame('baseline'),
    frame('current'),
  ]);
  const endpoint = `${origin}/api/v1/ci/runs`;
  const auth = { Authorization: `Bearer ${credential.token}` };
  const uploadTimes: number[] = [];
  async function submit(index: number, modified: boolean) {
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'Idempotency-Key': `bench-${index}`,
      },
      body: JSON.stringify({
        branch: index === 0 ? 'main' : 'ci-benchmark',
        commit: index.toString(16).padStart(40, '0'),
        captures: [modified ? changed : original],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok)
      throw new Error(`Benchmark upload failed with HTTP ${response.status}`);
    const { id } = (await response.json()) as { id: string };
    if (index) uploadTimes.push(performance.now() - started);
    return id;
  }
  const initial = await submit(0, false);
  assert.equal(await worker.runOne(), true);
  const job = (await queue.detail(scope, initial)).jobs[0]!;
  assert.ok(job.result);
  const version = await baselines.createCandidate(
    scope,
    job.result.identity,
    null,
    {
      png: Buffer.from(original.image, 'base64'),
      metadata: job.result.capture,
    },
    job.id,
  );
  await baselines.review(scope, version.id, 'approve');
  processing = worker.run(controller.signal, (code) => console.error(code));

  const queueStarted = performance.now();
  const results: { id: string; expected: string }[] = [];
  await Promise.all(
    [1, 2].map(async (first) => {
      for (let index = first; index <= 16; index += 2) {
        const modified = index % 2 === 0;
        results.push({
          expected: modified ? 'review_required' : 'passed',
          id: await submit(index, modified),
        });
      }
    }),
  );
  const pending = new Map(results.map(({ id, expected }) => [id, expected]));
  const deadline = Date.now() + 45_000;
  while (pending.size && Date.now() < deadline) {
    for (const [id, expected] of pending) {
      const response = await fetch(`${endpoint}/${id}`, {
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const { status } = (await response.json()) as { status: string };
      if (status === 'pending') continue;
      assert.equal(status, expected);
      pending.delete(id);
    }
    if (pending.size) await delay(150);
  }
  assert.equal(
    pending.size,
    0,
    'All 16 jobs should finish in the benchmark window',
  );
  uploadTimes.sort((a, b) => a - b);
  const metrics = await queue.metrics(scope);
  console.log(
    JSON.stringify(
      {
        cases: 16,
        expectedClean: 8,
        expectedReview: 8,
        uploadConcurrency: 2,
        workers: 1,
        screenshot: readImageSize(Buffer.from(original.image, 'base64')),
        uploadP95Ms: Math.round(
          uploadTimes[Math.ceil(0.95 * uploadTimes.length) - 1]!,
        ),
        elapsedMs: Math.round(performance.now() - queueStarted),
        turnaroundP95MsIncludingBaseline: metrics.p95_ms,
        queueP95MsIncludingBaseline: metrics.p95_queue_ms,
        completedIncludingBaseline: metrics.completed,
        failed: metrics.failed,
      },
      null,
      2,
    ),
  );
} finally {
  controller.abort();
  await processing;
  await app?.close();
  await database.close();
}
