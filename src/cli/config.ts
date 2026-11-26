import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import {
  browserEngines,
  desktopProfile,
  validateCapture,
  type CaptureRequest,
  type StorageState,
} from '../capture/policy.ts';

export const safeKey = /^[a-z0-9_-]{1,80}$/i;
export const applicationPath = z
  .string()
  .max(500)
  .refine(
    (path) =>
      path.startsWith('/') &&
      !path.startsWith('//') &&
      !/[\\?#\s]/u.test(path) &&
      URL.parse(path, 'http://localhost')?.pathname === path,
  );
const dimension = z.number().int().min(100).max(3000);
const selector = z.string().trim().min(1).max(300);
const checkpoint = z.strictObject({
  key: z.string().regex(safeKey),
  width: dimension,
  height: dimension,
  browser: z.enum(browserEngines).optional(),
  selector: selector.optional(),
  masks: z.array(selector).max(20).optional(),
});
const comparison = z.strictObject({
  pixelThreshold: z.number().min(0).max(1).optional(),
  maxChangedPixels: z.number().int().min(0).max(12_000_000).optional(),
  maxChangedRatio: z.number().min(0).max(1).optional(),
  includeAntialiasing: z.boolean().optional(),
});
const applicationConfig = z.strictObject({
  version: z.literal(2),
  baseURL: z.url(),
  routes: z
    .array(
      z.union([
        applicationPath,
        z.strictObject({
          path: applicationPath,
          readySelector: selector.optional(),
          selector: selector.optional(),
          masks: z.array(selector).max(20).optional(),
        }),
      ]),
    )
    .min(1)
    .max(40),
  viewports: z
    .array(
      z.strictObject({
        width: dimension,
        height: dimension,
        browser: z.enum(browserEngines).optional(),
      }),
    )
    .min(1)
    .max(8),
  criticalRoutes: z.array(applicationPath).max(40).optional(),
  capture: z
    .strictObject({
      disableAnimations: z.literal(true).optional(),
      waitForFonts: z.literal(true).optional(),
      clock: z.string().optional(),
      randomSeed: z.number().int().min(0).max(0xffffffff).optional(),
      timeoutMs: z.number().int().min(250).max(60_000).optional(),
      storageState: z.string().min(1).optional(),
      jsonFixtures: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  verification: z
    .strictObject({
      mode: z.enum(['review', 'strict']).default('review'),
      autoApprove: z.literal(false).optional(),
      intent: z.string().min(1).optional(),
    })
    .optional(),
  comparison: comparison.optional(),
});
const fixtureConfig = z.strictObject({
  version: z.literal(1),
  checkpoints: z.array(checkpoint).min(1).max(6),
  comparison: comparison.optional(),
});
const configSchema = z.discriminatedUnion('version', [
  fixtureConfig,
  applicationConfig,
]);
export type ApplicationConfig = Omit<
  z.input<typeof applicationConfig>,
  'version'
> & { version?: 2 };

export function defineConfig(
  config: ApplicationConfig,
): z.output<typeof applicationConfig> {
  return applicationConfig.parse({ ...config, version: config.version ?? 2 });
}

async function readStorageState(file: string): Promise<StorageState> {
  const schema = z.object({
    cookies: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(['Strict', 'Lax', 'None']),
      }),
    ),
    origins: z.array(
      z.object({
        origin: z.string(),
        localStorage: z.array(
          z.object({ name: z.string(), value: z.string() }),
        ),
      }),
    ),
  });
  const result = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!result.success) throw new Error('Invalid Playwright storage state');
  return result.data;
}

export async function readConfig(
  file: string,
  baseURL?: string,
  offline = false,
) {
  const moduleConfig = ['.ts', '.mts', '.js', '.mjs'].includes(
    extname(file).toLowerCase(),
  );
  const raw: unknown = moduleConfig
    ? ((await import(pathToFileURL(file).href)) as { default: unknown }).default
    : JSON.parse(await readFile(file, 'utf8'));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map(
      ({ path, message }) => `${path.join('.') || 'config'}: ${message}`,
    );
    throw new Error(`Invalid capture config: ${fields.join('; ')}`);
  }
  const config = result.data;
  if (config.version === 1) {
    if (baseURL) throw new Error('--base-url requires an application config');
    if (
      new Set(config.checkpoints.map(({ key }) => key.toLowerCase())).size !==
      config.checkpoints.length
    )
      throw new Error('Checkpoint keys must be unique');
    return config;
  }
  const routes = config.routes.map((route) =>
    typeof route === 'string' ? { path: route } : route,
  );
  const routing = new Set(routes.map(({ path }) => path));
  if (
    routing.size !== routes.length ||
    config.criticalRoutes?.some((path) => !routing.has(path))
  )
    throw new Error(
      'Routes must be unique and include every configured critical route',
    );
  const viewports = config.viewports.map((viewport) => ({
    ...viewport,
    browser: viewport.browser ?? desktopProfile.browser,
  }));
  const keys = viewports.map(
    ({ browser, width, height }) => `${browser}-${width}x${height}`,
  );
  if (
    new Set(keys).size !== viewports.length ||
    routes.length * viewports.length > 80
  )
    throw new Error(
      'Use unique viewports and at most 80 route/viewport combinations',
    );
  const { capture } = config;
  const configuredOrigin = new URL(config.baseURL);
  if (
    !['http:', 'https:'].includes(configuredOrigin.protocol) ||
    configuredOrigin.href !== `${configuredOrigin.origin}/`
  )
    throw new Error(
      'baseURL must be an HTTP(S) origin without a path or credentials',
    );
  const storageState =
    !offline && capture?.storageState
      ? await readStorageState(resolve(dirname(file), capture.storageState))
      : undefined;
  const requests = routes.flatMap((route) =>
    viewports.map((viewport, index) => {
      const { width, height, browser } = viewport;
      const request: CaptureRequest = {
        origin: baseURL ?? config.baseURL,
        profile: {
          ...desktopProfile,
          browser,
          viewport: { width, height },
          clock: capture?.clock ?? desktopProfile.clock,
        },
        target: { ...route, readySelector: route.readySelector ?? 'body' },
        timeoutMs: capture?.timeoutMs,
        randomSeed: capture?.randomSeed,
        jsonFixtures: capture?.jsonFixtures,
        storageState,
        snapshot: true,
      };
      validateCapture(request);
      return { path: route.path, viewportKey: keys[index]!, request };
    }),
  );
  return { ...config, routes, requests };
}
