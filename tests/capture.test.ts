import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { capture } from '../src/capture/engine.ts';
import {
  CaptureError,
  desktopProfile,
  type CaptureRequest,
} from '../src/capture/policy.ts';
import { fixtureData } from '../src/fixture/page.ts';
import { startFixture } from '../src/fixture/server.ts';

const run = promisify(execFile);
let fixture: Awaited<ReturnType<typeof startFixture>>;
before(async () => {
  fixture = await startFixture();
});
after(async () => {
  await fixture?.close();
});

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    origin: fixture.origin,
    profile: desktopProfile,
    target: { path: '/analytics', readySelector: 'main[data-ready="true"]' },
    ...overrides,
  };
}

test(
  'desktop fixture is byte-identical over ten fresh browsers',
  { timeout: 70_000 },
  async () => {
    const first = await capture(request());
    assert.deepEqual(
      first.png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(first.metadata.width, 1200);
    assert.ok(first.metadata.height >= 800 && first.metadata.height < 880);
    assert.equal(
      first.metadata.sha256,
      createHash('sha256').update(first.png).digest('hex'),
    );
    assert.equal(first.metadata.sizeBytes, first.png.length);
    assert.equal(first.metadata.clock, desktopProfile.clock);
    assert.ok(first.metadata.browserVersion);
    for (let attempt = 1; attempt < 10; attempt++) {
      const actual = await capture(request());
      assert.equal(
        actual.metadata.sha256,
        first.metadata.sha256,
        `capture ${attempt + 1}`,
      );
      assert.ok(actual.png.equals(first.png));
    }
  },
);

test('mobile, component and HiDPI captures use physical PNG dimensions', async () => {
  const profile = {
    ...desktopProfile,
    viewport: { width: 390, height: 720 },
    deviceScaleFactor: 2,
  };
  const mobile = await capture(request({ profile }));
  assert.equal(mobile.metadata.width, 780);
  assert.ok(
    mobile.metadata.height > 1440,
    'full page includes the area below the fold',
  );
  assert.equal(mobile.metadata.deviceScaleFactor, 2);
  const component = await capture(
    request({ profile, target: { ...request().target, selector: '.chart' } }),
  );
  assert.equal(component.metadata.mode, 'component');
  assert.equal(component.metadata.width, 724);
  assert.ok(component.metadata.height > 300 && component.metadata.height < 600);
});

for (const browser of ['firefox', 'webkit'] as const) {
  test(
    `${browser} provides ten repeatable full-page captures`,
    { timeout: 70_000 },
    async () => {
      const input = request({ profile: { ...desktopProfile, browser } });
      const first = await capture(input);
      assert.equal(first.metadata.browser, browser);
      assert.equal(first.metadata.width, 1200);
      for (let attempt = 1; attempt < 10; attempt++) {
        const actual = await capture(input);
        assert.equal(
          actual.metadata.sha256,
          first.metadata.sha256,
          `capture ${attempt + 1}`,
        );
        assert.ok(actual.png.equals(first.png));
      }
    },
  );
}

test('mask removes an observed dynamic difference', async () => {
  const target = { ...request().target, path: '/analytics?dynamic=1' };
  const first = await capture(request({ target }));
  const second = await capture(request({ target }));
  assert.notEqual(first.metadata.sha256, second.metadata.sha256);
  const maskedTarget = { ...target, masks: ['.dynamic'] };
  const masked = await capture(request({ target: maskedTarget }));
  assert.deepEqual(
    (await capture(request({ target: maskedTarget }))).png,
    masked.png,
  );
});

test('authenticated storage state and exact-path JSON mocks affect the rendered capture', async () => {
  const target = { ...request().target, path: '/private' };
  await assert.rejects(capture(request({ target })), {
    code: 'navigation',
    message: /401/,
  });
  const storageState = {
    cookies: [
      {
        name: 'fixture_session',
        value: 'fixture-test',
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };
  const original = await capture(request({ target, storageState }));
  const count = fixture.metricsRequests();
  const mocked = await capture(
    request({
      target,
      storageState,
      jsonFixtures: {
        '/fixture/metrics': { ...fixtureData, revenue: 1 },
      },
    }),
  );
  assert.equal(fixture.metricsRequests(), count);
  assert.notEqual(mocked.metadata.sha256, original.metadata.sha256);
  await assert.rejects(capture(request({ target })), {
    code: 'navigation',
    message: /401/,
  });
});

test('capture reports bad input, rejected navigation, readiness timeouts and oversized pages', async () => {
  await assert.rejects(
    capture(
      request({
        target: { ...request().target, path: '//elsewhere.invalid/' },
      }),
    ),
    { code: 'invalid_configuration' },
  );
  for (const path of ['/no-such-page', '/redirect']) {
    await assert.rejects(
      capture(request({ target: { ...request().target, path } })),
      { code: 'navigation' },
    );
  }
  let finish: unknown;
  try {
    fixture.selectVariant('loading');
    await capture(request({ timeoutMs: 3000 }));
  } catch (error) {
    finish = error;
  } finally {
    fixture.selectVariant('original');
  }
  assert.ok(finish instanceof CaptureError);
  assert.equal(finish.code, 'timeout');
  assert.equal(finish.phase, 'not_ready');
  fixture.selectVariant('tall');
  try {
    await assert.rejects(capture(request()), { code: 'capture_area' });
  } finally {
    fixture.selectVariant('original');
  }
});

test(
  'capture subprocess exits cleanly and reports an unavailable browser',
  { timeout: 25_000 },
  async (context) => {
    const empty = await mkdtemp(join(tmpdir(), 'deltaframe-browser-'));
    context.after(() => rm(empty, { recursive: true, force: true }));
    const script = `import {capture} from './src/capture/engine.ts';
    try { await capture(${JSON.stringify(request())}); process.stdout.write('completed'); }
    catch (error) { process.stdout.write(error.code); }`;
    const command = ['--input-type=module', '-e', script];
    assert.equal(
      (await run(process.execPath, command, { timeout: 15_000 })).stdout,
      'completed',
    );
    assert.equal(
      (
        await run(process.execPath, command, {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
          timeout: 5000,
        })
      ).stdout,
      'browser_launch',
    );
  },
);
