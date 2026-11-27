import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { RunQueue } from '../src/execution/queue.ts';
import { initializeLocalOperator } from '../src/execution/runtime.ts';
import { Worker } from '../src/execution/worker.ts';
import { startFixture } from '../src/fixture/server.ts';
import { digestOf, DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines } from '../src/persistence/baselines.ts';
import { createApp } from '../src/server/app.ts';
import { testDatabase } from './support/postgres.ts';

const run = promisify(execFile);

test(
  'CI capture uploads reach the review workspace with scoped credentials and branch protection',
  { timeout: 90_000 },
  async (context) => {
    const database = await testDatabase();
    context.after(() => database.close());
    const artifacts = new DiskArtifacts(join(database.directory, 'artifacts'));
    const queue = new RunQueue(database.pool);
    const operator = await initializeLocalOperator(database.pool);
    const baselines = new Baselines(database.pool, artifacts);
    const worker = new Worker(queue, baselines, artifacts);
    const operatorToken = randomBytes(32).toString('base64url');
    const metricsToken = randomBytes(32).toString('base64url');
    const app = createApp(
      false,
      { queue, operator, baselines, artifacts, token: operatorToken },
      resolve('web-dist'),
      metricsToken,
    );
    context.after(() => app.close());
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const project = await queue.createProject(operator, 'Harbor Commerce');
    const other = await queue.createProject(operator, 'Other integration');
    const path = `/api/v1/projects/${project.id}`;
    const cid = `${path}/ci-credentials`;
    const ci = '/api/v1/ci/runs';
    async function api(
      endpoint: string,
      expected: number,
      options: {
        method?: string;
        data?: unknown;
        token?: string;
        key?: string;
      } = {},
    ) {
      const response = await fetch(`${origin}${endpoint}`, {
        method: options.method ?? 'GET',
        body:
          options.data === undefined ? undefined : JSON.stringify(options.data),
        headers: {
          Authorization: `Bearer ${options.token ?? operatorToken}`,
          ...(options.data === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
      });
      const text = await response.text();
      assert.equal(response.status, expected, text);
      return text ? JSON.parse(text) : undefined;
    }
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
    assert.equal((await fetch(`${origin}/metrics`)).status, 401);
    const credential = await api(cid, 201, {
      method: 'POST',
      data: { label: 'Integration workflow', baselineBranch: 'main' },
    });
    const otherCredential = await api(
      `/api/v1/projects/${other.id}/ci-credentials`,
      201,
      {
        method: 'POST',
        data: { label: 'Other CI', baselineBranch: 'main' },
      },
    );
    assert.match(credential.token, /^vui_ci_/);
    assert.equal((await api(cid, 200))[0].token, undefined);
    await api(cid, 401, { token: credential.token });
    await api(ci, 401, { method: 'POST', data: {}, key: 'bad-auth' });
    const fixture = await startFixture();
    context.after(() => fixture.close());
    const config = join(database.directory, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        baseURL: fixture.origin,
        routes: [
          { path: '/analytics', readySelector: 'main[data-ready="true"]' },
        ],
        viewports: [{ width: 1200, height: 800 }],
      }),
    );
    async function cli(args: string[], expected = 0) {
      try {
        const output = await run(
          process.execPath,
          ['dist/cli/main.js', ...args],
          {
            env: { ...process.env, VERITYUI_CI_TOKEN: credential.token },
            timeout: 25_000,
          },
        );
        assert.equal(expected, 0);
        return JSON.parse(output.stdout);
      } catch (error) {
        const failure = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        assert.equal(failure.code, expected, failure.stderr);
        return JSON.parse(failure.stdout || failure.stderr || '{}');
      }
    }
    const directory = join(database.directory, 'reference');
    await cli([
      'capture',
      '--config',
      config,
      '--output',
      directory,
      '--commit',
      'a'.repeat(40),
    ]);
    const args = [
      'upload',
      '--api',
      origin,
      '--key',
      'main-job',
      '--branch',
      'main',
      '--input',
      directory,
    ];
    const first = await cli(args);
    assert.equal((await cli(args)).id, first.id);
    assert.match(first.dashboard, /\?project=.+&run=/);
    await api(`${ci}/${first.id}`, 404, { token: otherCredential.token });
    await api(`${path}/runs/${first.id}`, 401, { token: credential.token });
    assert.equal(await worker.runOne(), true);
    assert.equal((await cli([...args, '--wait'], 2)).status, 'review_required');
    const initial = await api(`${path}/runs/${first.id}`, 200);
    const initialBaseline = await api(
      `${path}/runs/${first.id}/jobs/${initial.jobs[0].id}/candidate`,
      200,
      { method: 'POST' },
    );
    const review = (id: string) => `${path}/baselines/${id}/review`;
    assert.equal(
      (
        await api(review(initialBaseline.id), 200, {
          method: 'POST',
          data: { action: 'approve' },
        })
      ).status,
      'approved',
    );

    const retry = await cli([
      'upload',
      '--api',
      origin,
      '--key',
      'matching-run',
      '--branch',
      'main',
      '--input',
      directory,
    ]);
    assert.equal(await worker.runOne(), true);
    assert.equal(
      (await api(`${ci}/${retry.id}`, 200, { token: credential.token })).status,
      'passed',
    );

    fixture.selectVariant('color');
    const candidateDirectory = join(database.directory, 'candidate');
    await cli([
      'capture',
      '--config',
      config,
      '--output',
      candidateDirectory,
      '--commit',
      'b'.repeat(40),
    ]);
    const candidateArgs = [
      'upload',
      '--api',
      origin,
      '--branch',
      'feature/chart-color',
      '--input',
      candidateDirectory,
    ];
    const conflicting = await cli([...candidateArgs, '--key', 'main-job'], 3);
    assert.match(conflicting.error, /Idempotency key/);
    const changed = await cli(candidateArgs);
    assert.equal(await worker.runOne(), true);
    const detail = await api(`${path}/runs/${changed.id}`, 200);
    const job = detail.jobs[0];
    assert.equal(job.result.comparison.status, 'changed');
    assert.equal(job.checkpoint.route, '/analytics');
    assert.ok(
      job.result.structure.changes.some(
        (change: { properties: { name: string }[] }) =>
          change.properties.some(({ name }) => name === 'background-color'),
      ),
    );
    const changeVersion = await api(
      `${path}/runs/${changed.id}/jobs/${job.id}/candidate`,
      200,
      { method: 'POST' },
    );
    await api(review(changeVersion.id), 409, {
      method: 'POST',
      data: { action: 'approve' },
    });
    const quality = await api(`${path}/metrics`, 200);
    assert.equal(quality.runs, 3);
    assert.equal(quality.completed, 3);
    assert.equal(quality.review_required, 1);
    assert.equal(quality.timed_checkpoints, 3);
    assert.ok(quality.p95_ms >= 0);
    assert.ok(
      quality.p95_queue_ms >= 0 && quality.p95_ms >= quality.p95_queue_ms,
    );

    const browser = await chromium.launch({ channel: 'chromium' });
    context.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(changed.dashboard);
    await page.getByLabel('Operator token').fill(operatorToken);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'feature/chart-color' }).waitFor();
    await page.getByRole('button', { name: 'Diff', exact: true }).click();
    await page
      .getByRole('img', { name: 'Diff screenshot' })
      .evaluate((image) => (image as HTMLImageElement).decode());
    await page.getByText('Element changes', { exact: false }).click();
    await page.getByText('background-color', { exact: true }).first().waitFor();
    await page.getByText('Element changes', { exact: false }).click();
    await page.getByText('P95 turnaround', { exact: true }).waitFor();
    await mkdir(resolve('data/demo'), { recursive: true });
    await page.screenshot({
      path: resolve('data/demo/verityui-workspace-next.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'CI settings', exact: true })
      .click();
    await page.getByText('Integration workflow', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page
      .getByRole('button', { name: 'Run history', exact: true })
      .click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );

    await api(review(changeVersion.id), 200, {
      method: 'POST',
      data: { action: 'reject' },
    });
    assert.equal((await api(`${path}/metrics`, 200)).review_required, 0);

    const manifest = JSON.parse(
      await readFile(join(directory, 'reference.json'), 'utf8'),
    );
    const frame = manifest.captures[0];
    const truncated = (
      await readFile(join(directory, `${frame.key}.png`))
    ).subarray(0, 33);
    const invalid = await api(ci, 202, {
      method: 'POST',
      token: credential.token,
      key: 'corrupt-artifact',
      data: {
        commit: 'c'.repeat(40),
        branch: 'main',
        captures: [
          {
            key: frame.key,
            route: frame.route,
            identity: frame.identity,
            image: truncated.toString('base64'),
            metadata: {
              ...frame.metadata,
              sha256: digestOf(truncated),
              sizeBytes: truncated.length,
            },
          },
        ],
      },
    });
    assert.equal(await worker.runOne(), true);
    assert.equal(
      (await api(`${ci}/${invalid.id}`, 200, { token: credential.token }))
        .status,
      'inconclusive',
    );
    assert.equal((await api(`${path}/metrics`, 200)).failed, 1);
    await api(`${cid}/${credential.id}`, 204, { method: 'DELETE' });
    await api(`${ci}/${first.id}`, 401, { token: credential.token });
    const scrape = await fetch(`${origin}/metrics`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    assert.equal(scrape.status, 200);
    assert.match(
      await scrape.text(),
      /verityui_http_request_duration_seconds_count \d+/,
    );
  },
);
