import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { RunQueue } from '../src/execution/queue.ts';
import { initializeLocalOperator } from '../src/execution/runtime.ts';
import { Worker } from '../src/execution/worker.ts';
import { DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines } from '../src/persistence/baselines.ts';
import { createApp } from '../src/server/app.ts';
import { testDatabase } from './support/postgres.ts';

test(
  'review dashboard signs in, configures runs, compares evidence, approves and rejects',
  { timeout: 150_000 },
  async () => {
    const database = await testDatabase();
    const artifacts = new DiskArtifacts(join(database.directory, 'objects'));
    const queue = new RunQueue(database.pool);
    const baselines = new Baselines(database.pool, artifacts);
    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    let app: ReturnType<typeof createApp> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let running: Promise<void> | undefined;

    try {
      const operator = await initializeLocalOperator(database.pool);
      const secondary = randomUUID();
      await database.pool.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'QA workspace')",
        [secondary],
      );
      await database.pool.query(
        "INSERT INTO memberships (org_id, principal_id, role) VALUES ($1, $2, 'viewer')",
        [secondary, operator.actorId],
      );
      app = createApp(
        false,
        { token, operator, queue, baselines, artifacts },
        resolve('web-dist'),
      );
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      running = new Worker(queue, baselines, artifacts).run(
        controller.signal,
        () => undefined,
      );
      browser = await chromium.launch({ channel: 'chromium' });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      });
      page.setDefaultTimeout(10000);
      const clientErrors: string[] = [];
      page.on('pageerror', (error) => clientErrors.push(error.message));
      await page.goto(address);
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      assert.equal((await fetch(`${address}/api/v1/projects`)).status, 401);
      await page.getByLabel('Operator token').fill('incorrect');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page
        .getByRole('alert')
        .getByText('Operator token was not accepted')
        .waitFor();
      await page.getByLabel('Operator token').fill(token);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page
        .getByRole('heading', { name: 'Visual review workspace' })
        .waitFor();
      const session = (await page.context().cookies()).find(
        ({ name }) => name === 'deltaframe_session',
      );
      assert.equal(session?.httpOnly, true);
      assert.equal(session?.sameSite, 'Strict');

      const workspace = page.getByLabel('Workspace', { exact: true });
      await Promise.all([
        page.waitForResponse(
          (value) =>
            value.url().endsWith('/api/v1/session') &&
            value.request().method() === 'PATCH' &&
            value.ok(),
        ),
        workspace.selectOption(secondary),
      ]);
      await page.waitForFunction(
        (id) =>
          (
            document.querySelector(
              'select[aria-label="Workspace"]',
            ) as HTMLSelectElement
          )?.value === id,
        secondary,
      );
      const outsideWorkspace = await page.request.patch(
        `${address}/api/v1/session`,
        { data: { workspaceId: randomUUID() } },
      );
      assert.equal(outsideWorkspace.status(), 403);
      const viewerCreate = await page.request.post(
        `${address}/api/v1/projects`,
        { data: { name: 'Viewer cannot create' } },
      );
      assert.equal(viewerCreate.status(), 403);
      const forgedOrigin = await page.request.post(
        `${address}/api/v1/projects`,
        {
          data: { name: 'Wrong origin' },
          headers: { origin: 'https://another.invalid' },
        },
      );
      assert.equal(forgedOrigin.status(), 403);
      await Promise.all([
        page.waitForResponse(
          (value) =>
            value.url().endsWith('/api/v1/session') &&
            value.request().method() === 'PATCH' &&
            value.ok(),
        ),
        workspace.selectOption(operator.organizationId),
      ]);
      await page.waitForFunction(
        (id) =>
          (
            document.querySelector(
              'select[aria-label="Workspace"]',
            ) as HTMLSelectElement
          )?.value === id,
        operator.organizationId,
      );

      await page
        .locator('.sidebar')
        .getByRole('button', { name: 'New project' })
        .click();
      await page.getByLabel('Project name').fill('Harbor Analytics');
      await page.getByRole('button', { name: 'Create project' }).click();
      await page.getByRole('heading', { name: 'Harbor Analytics' }).waitFor();
      await page.getByRole('button', { name: 'Test suite' }).click();
      await page.getByRole('button', { name: 'Save suite' }).click();
      await page.getByRole('button', { name: 'Start run' }).click();
      await page
        .getByRole('img', { name: 'Current screenshot' })
        .waitFor({ timeout: 16000 });
      await page.waitForFunction(
        () =>
          (
            document.querySelector(
              'img[alt="Current screenshot"]',
            ) as HTMLImageElement
          )?.naturalWidth > 0,
      );
      await page.getByRole('button', { name: 'Approve baseline' }).click();
      await page
        .locator('.review-actions')
        .getByText('Approved', { exact: true })
        .waitFor();

      await page.getByLabel('Fixture variant').selectOption('color');
      await page.getByRole('button', { name: 'Start run' }).click();
      await page
        .getByRole('button', { name: 'Diff', exact: true })
        .click({ timeout: 16000 });
      const diff = page.getByRole('img', { name: 'Diff screenshot' });
      const diffPath = await diff.getAttribute('src');
      assert.ok(diffPath);
      await page.waitForFunction(
        () =>
          (
            document.querySelector(
              'img[alt="Diff screenshot"]',
            ) as HTMLImageElement
          )?.naturalWidth > 0,
      );
      await mkdir(resolve('data', 'demo'), { recursive: true });
      await page.screenshot({
        path: resolve('data', 'demo', 'workspace.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Compare', exact: true }).click();
      const slider = page.getByRole('slider');
      await slider.focus();
      await slider.press('ArrowRight');
      assert.equal(await slider.inputValue(), '51');
      await page.getByText('Investigation', { exact: true }).click();
      await page.getByText(/Most changed pixels were colored/).waitFor();
      await page.getByRole('button', { name: 'Helpful', exact: true }).click();
      await page.getByRole('status').getByText('Feedback saved').waitFor();
      await page.getByRole('button', { name: 'Reject change' }).click();
      await page
        .locator('.review-actions')
        .getByText('Rejected', { exact: true })
        .waitFor();

      await page.setViewportSize({ width: 390, height: 760 });
      await page.reload();
      await page
        .locator('.review-actions')
        .getByText('Rejected', { exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page
        .locator('.history')
        .getByRole('button', { name: /Original fixture/ })
        .click();
      await page
        .locator('.review-actions')
        .getByText('Approved', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      assert.equal(
        (await page.request.get(`${address}${diffPath}`)).status(),
        401,
      );
      assert.deepEqual(clientErrors, []);
    } finally {
      controller.abort();
      await running;
      await browser?.close();
      await app?.close();
      await database.close();
    }
  },
);
