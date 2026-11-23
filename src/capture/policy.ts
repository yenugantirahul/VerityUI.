import { arch, platform, release } from 'node:os';
import type { BrowserContextOptions } from 'playwright';

export const maxCapturePixels = 12_000_000;
export const browserEngines = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserEngine = (typeof browserEngines)[number];
export type StorageState = Exclude<
  BrowserContextOptions['storageState'],
  string | undefined
>;

export interface CaptureProfile {
  browser: BrowserEngine;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  clock: string;
}

export interface CaptureTarget {
  path: string;
  readySelector: string;
  selector?: string;
  masks?: readonly string[];
}

export interface CaptureRequest {
  origin: string;
  profile: CaptureProfile;
  target: CaptureTarget;
  jsonFixtures?: Readonly<Record<string, unknown>>;
  storageState?: StorageState;
  timeoutMs?: number;
}

export const desktopProfile = {
  browser: 'chromium',
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  clock: '2026-01-15T12:00:00.000Z',
} satisfies CaptureProfile;

export const renderingEnvironment = {
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  renderer: process.env.DELTAFRAME_RENDERER ?? 'native',
};

export type CaptureErrorCode =
  | 'invalid_configuration'
  | 'browser_launch'
  | 'navigation'
  | 'not_ready'
  | 'capture_area'
  | 'capture'
  | 'unstable_rendering'
  | 'timeout'
  | 'cleanup';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly phase?: string;

  constructor(code: CaptureErrorCode, message: string, phase?: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.phase = phase;
  }
}

export function validateCapture(request: CaptureRequest) {
  try {
    const { target, profile, jsonFixtures, storageState } = request;
    const { width, height } = profile.viewport;
    const scale = profile.deviceScaleFactor;
    const timeout = request.timeoutMs ?? 15_000;
    const origin = new URL(request.origin);
    const url = new URL(target.path, origin);
    const localPath = (value: string) =>
      value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
    const invalidSelector = (value: string) =>
      !value.trim() || value.length > 300;
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.href !== `${origin.origin}/` ||
      url.origin !== origin.origin ||
      !localPath(target.path) ||
      target.path.length > 2048 ||
      !browserEngines.includes(profile.browser) ||
      ![width, height].every(
        (value) => Number.isInteger(value) && value >= 100 && value <= 3000,
      ) ||
      !Number.isInteger(scale) ||
      scale < 1 ||
      scale > 3 ||
      width * height * scale ** 2 > maxCapturePixels ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        profile.clock,
      ) ||
      !Number.isFinite(Date.parse(profile.clock)) ||
      !Number.isInteger(timeout) ||
      timeout < 250 ||
      timeout > 60_000 ||
      invalidSelector(target.readySelector) ||
      (target.selector !== undefined && invalidSelector(target.selector)) ||
      (target.masks?.length ?? 0) > 20 ||
      target.masks?.some(invalidSelector) ||
      Object.keys(jsonFixtures ?? {}).some((key) => !localPath(key)) ||
      storageState?.origins.some((item) => item.origin !== origin.origin) ||
      storageState?.cookies.some((cookie) => cookie.domain !== origin.hostname)
    ) {
      throw new Error('Invalid capture policy');
    }
    new Intl.DateTimeFormat(profile.locale, { timeZone: profile.timezoneId });
    return { url, timeout };
  } catch {
    throw new CaptureError(
      'invalid_configuration',
      'Capture configuration failed validation.',
    );
  }
}
