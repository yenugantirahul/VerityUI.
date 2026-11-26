import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { RunQueue, type Claim } from '../src/execution/queue.ts';
import { initializeLocalOperator } from '../src/execution/runtime.ts';
import { Worker } from '../src/execution/worker.ts';
import { DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines } from '../src/persistence/baselines.ts';
import { createApp } from '../src/server/app.ts';
import { testDatabase } from './support/postgres.ts';

test(
  'HTTP API and durable workers capture, compare, persist and deliver private evidence',
  { timeout: 170_000 },
  async (context) => {
    const database = await testDatabase();
    context.after(() => database.close());
    const { pool } = database;
    const queue = new RunQueue(pool);
    const artifacts = new DiskArtifacts(join(database.directory, 'objects'));
    const baselines = new Baselines(pool, artifacts);
    const operator = await initializeLocalOperator(pool);
    const worker = new Worker(queue, baselines, artifacts, 6000);
    const token = randomBytes(32).toString('hex');
    const app = createApp(false, {
      token,
      operator,
      queue,
      baselines,
      artifacts,
    });
    context.after(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `${address}/api/v1`;

    async function call(
      path: string,
      method = 'GET',
      body?: unknown,
      key?: string,
    ) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (key) headers['idempotency-key'] = key;
      return fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function response<T>(
      operation: Promise<Response>,
      expected: number,
    ): Promise<T> {
      const value = await operation;
      const payload = await value.json();
      assert.equal(value.status, expected, JSON.stringify(payload));
      return payload as T;
    }
    type Run = { id: string };
    type Detail = Awaited<ReturnType<RunQueue['detail']>>;

    assert.equal((await fetch(`${base}/projects`)).status, 401);
    await response(call('/projects', 'POST', { name: '  ' }), 400);
    const project = await response<{ id: string }>(
      call('/projects', 'POST', { name: 'Harbor' }),
      201,
    );
    const path = `/projects/${project.id}`;
    const checkpoint = { key: 'dashboard', width: 1200, height: 800 };
    await response(
      call(`${path}/suite`, 'PUT', {
        checkpoints: [{ ...checkpoint, width: -1 }],
      }),
      400,
    );
    const suite = await response<{ id: string }>(
      call(`${path}/suite`, 'PUT', { checkpoints: [checkpoint] }),
      201,
    );
    const firstBody = { suiteId: suite.id, variant: 'original' };
    const submitted = await Promise.all([
      response<Run>(call(`${path}/runs`, 'POST', firstBody, 'first'), 202),
      response<Run>(call(`${path}/runs`, 'POST', firstBody, 'first'), 202),
    ]);
    assert.equal(submitted[0].id, submitted[1].id);
    await response(
      call(`${path}/runs`, 'POST', { ...firstBody, variant: 'color' }, 'first'),
      409,
    );
    const firstPath = `${path}/runs/${submitted[0].id}`;
    assert.equal(
      (await response<Detail>(call(firstPath), 200)).jobs[0]?.state,
      'queued',
    );
    assert.deepEqual(
      (await Promise.all([worker.runOne(), worker.runOne()])).sort(),
      [false, true],
    );
    const first = (await response<Detail>(call(firstPath), 200)).jobs[0]!;
    assert.equal(first.state, 'completed');
    assert.equal(first.result?.comparison.status, 'missing');
    const candidatePath = `${firstPath}/jobs/${first.id}/candidate`;
    const candidates = await Promise.all([
      response<{ id: string }>(call(candidatePath, 'POST'), 200),
      response<{ id: string }>(call(candidatePath, 'POST'), 200),
    ]);
    assert.equal(candidates[0].id, candidates[1].id);
    const promoted = await promisify(execFile)(
      process.execPath,
      [
        'dist/cli/main.js',
        'review',
        '--api',
        address,
        '--project',
        project.id,
        '--run',
        submitted[0].id,
        '--job',
        first.id,
        '--action',
        'approve',
      ],
      { env: { ...process.env, DELTAFRAME_API_TOKEN: token }, timeout: 25000 },
    );
    assert.equal(JSON.parse(promoted.stdout).id, candidates[0].id);
    assert.equal(JSON.parse(promoted.stdout).status, 'approved');

    const next = await response<Run>(
      call(
        `${path}/runs`,
        'POST',
        { ...firstBody, variant: 'color' },
        'second',
      ),
      202,
    );
    const runPath = `${path}/runs/${next.id}`;
    const child = spawn(process.execPath, ['src/execution/worker-main.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: database.connectionString,
        ARTIFACT_DIR: join(database.directory, 'objects'),
      },
      windowsHide: true,
      stdio: 'ignore',
    });
    const stopped = once(child, 'exit');
    let abandoned: Claim | undefined;
    try {
      for (let attempt = 0; attempt < 200 && !abandoned; attempt++) {
        const claim = await pool.query<Claim>(
          `
          SELECT jobs.id, jobs.lease_id, jobs.checkpoint, jobs.attempts, runs.org_id,
            runs.project_id, runs.actor_id, runs.variant FROM jobs JOIN runs ON runs.id = jobs.run_id
          WHERE jobs.run_id = $1 AND jobs.state = 'running'
        `,
          [next.id],
        );
        abandoned = claim.rows[0];
        if (!abandoned) await delay(35);
      }
      assert.ok(abandoned, 'worker process acquired a durable lease');
    } finally {
      child.kill('SIGKILL');
      await stopped;
    }
    await pool.query(
      "UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [abandoned.id],
    );
    const blockedRoot = join(database.directory, 'blocked-objects');
    await writeFile(blockedRoot, 'blocked');
    const storageFailure = new Worker(
      queue,
      baselines,
      new DiskArtifacts(blockedRoot),
      6000,
    );
    assert.equal(await storageFailure.runOne(), true);
    const delayed = (await response<Detail>(call(runPath), 200)).jobs[0]!;
    assert.equal(delayed.state, 'queued');
    assert.equal(delayed.attempts, 2);
    assert.equal(delayed.failure, 'storage_unavailable');
    await unlink(blockedRoot);
    await pool.query('UPDATE jobs SET available_at = now() WHERE id = $1', [
      abandoned.id,
    ]);

    await database.pause();
    await assert.rejects(queue.claim());
    await response(call(runPath), 503);
    await database.resume();
    assert.equal(await worker.runOne(), true);
    const changed = (await response<Detail>(call(runPath), 200)).jobs[0]!;
    assert.equal(changed.attempts, 3);
    assert.equal(changed.result?.comparison.status, 'changed');
    assert.equal(changed.result?.comparedBaselineId, candidates[0].id);
    const analysis = changed.result?.analysis;
    assert.ok(analysis?.state === 'available');
    assert.equal(analysis.classification, 'color');
    const feedback = `${runPath}/jobs/${changed.id}/analysis-feedback`;
    await response(
      call(feedback, 'POST', { version: 'obsolete', helpful: true }),
      404,
    );
    await response(
      call(feedback, 'POST', { version: analysis.version, helpful: true }),
      200,
    );
    const votes = await pool.query<{ helpful: boolean }>(
      'SELECT helpful FROM analysis_feedback WHERE job_id = $1',
      [changed.id],
    );
    assert.deepEqual(votes.rows, [{ helpful: true }]);
    assert.equal(await queue.complete(abandoned, changed.result!), false);
    const diffPath = `${runPath}/jobs/${changed.id}/evidence/diff`;
    const evidence = await call(diffPath);
    assert.equal(evidence.status, 200);
    assert.equal(evidence.headers.get('content-type'), 'image/png');
    assert.equal(evidence.headers.get('cache-control'), 'private, no-store');
    assert.equal(
      Buffer.from(await evidence.arrayBuffer()).toString('ascii', 1, 4),
      'PNG',
    );
    assert.equal((await fetch(`${base}${diffPath}`)).status, 401);
    await response(
      call(`${path}/runs/${randomUUID()}/jobs/${changed.id}/evidence/diff`),
      404,
    );
    const page = await response<Run[]>(call(`${path}/runs?limit=1`), 200);
    assert.deepEqual(
      page.map(({ id }) => id),
      [next.id],
    );
    const older = await response<Run[]>(
      call(`${path}/runs?limit=1&before=${next.id}`),
      200,
    );
    assert.deepEqual(
      older.map(({ id }) => id),
      [submitted[0].id],
    );

    const third = await response<Run>(
      call(`${path}/runs`, 'POST', firstBody, 'third'),
      202,
    );
    const cancelledClaim = await queue.claim();
    assert.ok(cancelledClaim);
    const cancelled = await response<Detail>(
      call(`${path}/runs/${third.id}/cancel`, 'POST'),
      200,
    );
    assert.equal(cancelled.jobs[0]?.state, 'cancelled');
    assert.equal(await queue.complete(cancelledClaim, changed.result!), false);
    assert.equal(await worker.runOne(), false);

    const mixedSuite = await response<{ id: string }>(
      call(`${path}/suite`, 'PUT', {
        checkpoints: [
          checkpoint,
          { ...checkpoint, key: 'unavailable', selector: '#never-rendered' },
        ],
      }),
      201,
    );
    const mixed = await response<Run>(
      call(`${path}/runs`, 'POST', { suiteId: mixedSuite.id }, 'partial'),
      202,
    );
    const fastWorker = new Worker(queue, baselines, artifacts, 3500, () => {
      throw new Error('Analysis unavailable');
    });
    for (let i = 0; i < 4; i++) {
      assert.equal(await fastWorker.runOne(), true);
      await pool.query(
        `UPDATE jobs SET available_at = now() WHERE run_id = $1 AND state = 'queued'`,
        [mixed.id],
      );
    }
    const mixedDetail = await response<Detail>(
      call(`${path}/runs/${mixed.id}`),
      200,
    );
    assert.equal(mixedDetail.jobs[0]?.result?.comparison.status, 'matched');
    assert.equal(mixedDetail.jobs[0]?.result?.analysis?.state, 'unavailable');
    assert.equal(mixedDetail.jobs[1]?.state, 'failed');
    assert.equal(mixedDetail.jobs[1]?.failure, 'timeout');
    assert.equal(mixedDetail.jobs[1]?.attempts, 3);

    const faulty = await response<Run>(
      call(
        `${path}/runs`,
        'POST',
        { suiteId: suite.id, variant: 'filter_broken' },
        'bad-filter',
      ),
      202,
    );
    assert.equal(await worker.runOne(), true);
    const badFilterPath = `${path}/runs/${faulty.id}`;
    const faultyJob = (await response<Detail>(call(badFilterPath), 200))
      .jobs[0]!;
    assert.equal(faultyJob.result?.comparison.status, 'matched');
    assert.equal(
      faultyJob.result?.checks?.find((check) => check.id === 'date_filter')
        ?.passed,
      false,
    );
    await response(
      call(`${badFilterPath}/jobs/${faultyJob.id}/candidate`, 'POST'),
      409,
    );
  },
);
