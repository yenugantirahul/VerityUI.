import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  chromium,
  errors,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import {
  CaptureError,
  maxCapturePixels,
  renderingEnvironment,
  validateCapture,
  type BrowserEngine,
  type CaptureRequest,
} from './policy.ts';
import { captureSnapshot, type Snapshot } from './snapshot.ts';

const engines = { chromium, firefox, webkit };

export interface CaptureResult {
  png: Buffer;
  snapshot?: Snapshot;
  metadata: typeof renderingEnvironment & {
    browser: BrowserEngine;
    browserVersion: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    locale: string;
    timezoneId: string;
    clock: string;
    mode: 'component' | 'full-page';
    width: number;
    height: number;
    sizeBytes: number;
    sha256: string;
    blockedRequests: number;
    durationMs: number;
  };
}

export async function capture(
  request: CaptureRequest,
  inspect?: (page: Page, remainingMs: number) => Promise<void>,
): Promise<CaptureResult> {
  const { url, timeout } = validateCapture(request);
  const { profile, target } = request;
  const started = performance.now();
  const remaining = () => {
    const budget = Math.ceil(timeout - (performance.now() - started));
    if (budget < 1) throw new errors.TimeoutError('Capture timeout');
    return budget;
  };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let deadlineExpired = false;
  let phase: 'browser_launch' | 'navigation' | 'not_ready' | 'capture' =
    'browser_launch';
  let result: CaptureResult;
  let cleanupFailed: boolean;

  try {
    browser = await engines[profile.browser].launch({
      headless: true,
      channel: profile.browser === 'chromium' ? 'chromium' : undefined,
      timeout: remaining(),
    });
    watchdog = setTimeout(() => {
      deadlineExpired = true;
      void browser?.close().catch(() => undefined);
    }, remaining());
    context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      locale: profile.locale,
      timezoneId: profile.timezoneId,
      storageState: request.storageState,
      serviceWorkers: 'block',
      acceptDownloads: false,
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });
    context.setDefaultTimeout(remaining());
    let blockedRequests = 0;
    let routeFailure = false;
    await context.routeWebSocket('**/*', async (socket) => {
      blockedRequests++;
      await socket.close();
    });
    await context.route('**/*', async (route) => {
      try {
        const destination = new URL(route.request().url());
        if (destination.origin !== url.origin) {
          blockedRequests++;
          await route.abort('blockedbyclient');
          return;
        }
        const path = `${destination.pathname}${destination.search}`;
        if (
          route.request().method() === 'GET' &&
          Object.hasOwn(request.jsonFixtures ?? {}, path)
        ) {
          await route.fulfill({ json: request.jsonFixtures?.[path] });
          return;
        }
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: remaining(),
        });
        try {
          if (
            response.status() >= 300 &&
            response.status() < 400 &&
            response.status() !== 304
          ) {
            blockedRequests++;
            routeFailure = true;
            await route.abort('blockedbyclient');
          } else {
            await route.fulfill({ response });
          }
        } finally {
          await response.dispose();
        }
      } catch {
        routeFailure = true;
        await route.abort('failed').catch(() => undefined);
      }
    });

    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(profile.clock));
    if (request.randomSeed !== undefined) {
      await page.addInitScript((seed) => {
        let state = seed;
        Math.random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 0x100000000;
        };
      }, request.randomSeed);
    }
    phase = 'navigation';
    const response = await page.goto(url.href, {
      waitUntil: 'load',
      timeout: remaining(),
    });
    if (!response?.ok() || new URL(page.url()).origin !== url.origin) {
      throw new CaptureError(
        'navigation',
        `Target navigation returned HTTP ${response?.status() ?? 'unknown'}.`,
      );
    }

    phase = 'not_ready';
    await page
      .locator(target.readySelector)
      .waitFor({ state: 'visible', timeout: remaining() });
    await inspect?.(page, remaining());
    await page.waitForFunction(
      () => document.fonts.status === 'loaded',
      undefined,
      {
        timeout: remaining(),
      },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    phase = 'capture';
    const component = target.selector
      ? page.locator(target.selector)
      : undefined;
    const area = component
      ? await component.boundingBox({ timeout: remaining() })
      : await page.evaluate(() => ({
          width: Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
            innerWidth,
          ),
          height: Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            innerHeight,
          ),
        }));
    if (
      !area ||
      Math.ceil(area.width * profile.deviceScaleFactor) *
        Math.ceil(area.height * profile.deviceScaleFactor) >
        maxCapturePixels
    ) {
      throw new CaptureError(
        'capture_area',
        'Target is hidden or exceeds the capture pixel budget.',
      );
    }
    const options = {
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
      mask: target.masks?.map((selector) => page.locator(selector)),
      maskColor: '#aeb8c7',
    } as const;
    const screenshot = () =>
      component
        ? component.screenshot({ ...options, timeout: remaining() })
        : page.screenshot({ ...options, fullPage: true, timeout: remaining() });
    let png = await screenshot();
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await screenshot();
      if (png.equals(next)) {
        stable = true;
        break;
      }
      png = next;
    }
    if (!stable)
      throw new CaptureError(
        'unstable_rendering',
        'The last consecutive screenshots differed.',
      );
    if (routeFailure)
      throw new CaptureError('navigation', 'A required target request failed.');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width * height > maxCapturePixels) {
      throw new CaptureError(
        'capture_area',
        'Screenshot exceeds the capture pixel budget.',
      );
    }
    result = {
      png,
      snapshot: request.snapshot
        ? await captureSnapshot(page, target, profile.deviceScaleFactor)
        : undefined,
      metadata: {
        ...renderingEnvironment,
        browser: profile.browser,
        browserVersion: browser.version(),
        viewport: { ...profile.viewport },
        deviceScaleFactor: profile.deviceScaleFactor,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        clock: new Date(profile.clock).toISOString(),
        mode: component ? 'component' : 'full-page',
        width,
        height,
        sizeBytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        blockedRequests,
        durationMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    if (deadlineExpired || error instanceof errors.TimeoutError) {
      throw new CaptureError('timeout', 'Capture deadline elapsed.', phase);
    }
    throw new CaptureError(
      phase,
      `Capture failed during ${phase.replace('_', ' ')}.`,
      phase,
    );
  } finally {
    clearTimeout(watchdog);
    const contextClosed = await context?.close().then(
      () => true,
      () => false,
    );
    const browserClosed = await browser?.close().then(
      () => true,
      () => false,
    );
    cleanupFailed = contextClosed === false || browserClosed === false;
  }
  if (cleanupFailed)
    throw new CaptureError('cleanup', 'Browser resources could not be closed.');
  return result;
}
