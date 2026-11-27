import * as z from 'zod';
import { browserEngines } from '../capture/policy.ts';

export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const commitSha = z.string().regex(/^[a-f0-9]{40}$/i);
export const captureKey = z.string().regex(/^[a-z0-9_-]{1,80}$/i);
export const branchName = z
  .string()
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes('..') && !value.includes('//') && !value.endsWith('/'),
  );
export const routePath = z
  .string()
  .max(500)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/[\\?#\s]/u.test(value) &&
      URL.parse(value, 'http://localhost')?.pathname === value,
  );
const dimension = z.number().int().min(1).max(12_000_000);
const viewportSize = z.number().int().min(100).max(3000);
const identifier = z.string().regex(/^[a-zA-Z0-9_.()+ -]{1,100}$/);
export const captureMetadata = z.strictObject({
  platform: z.enum([
    'aix',
    'android',
    'darwin',
    'freebsd',
    'haiku',
    'linux',
    'openbsd',
    'sunos',
    'win32',
    'cygwin',
    'netbsd',
  ]),
  architecture: z.enum([
    'arm',
    'arm64',
    'ia32',
    'loong64',
    'mips',
    'mipsel',
    'ppc64',
    'riscv64',
    's390x',
    'x64',
  ]),
  osRelease: identifier,
  renderer: identifier,
  browser: z.enum(browserEngines),
  browserVersion: identifier,
  viewport: z.strictObject({ width: viewportSize, height: viewportSize }),
  deviceScaleFactor: z.number().int().min(1).max(3),
  locale: identifier,
  timezoneId: z.string().regex(/^[a-zA-Z0-9_+/-]{1,80}$/),
  clock: z.iso.datetime(),
  mode: z.enum(['component', 'full-page']),
  width: dimension,
  height: dimension,
  sizeBytes: z.number().int().positive(),
  sha256,
  blockedRequests: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().max(120_000),
});

export const snapshotSchema = z.object({
  version: z.literal(1),
  truncated: z.boolean(),
  nodes: z
    .array(
      z.object({
        path: z.string().min(1).max(600),
        tag: z.string().min(1).max(100),
        component: z.string().max(80).optional(),
        testId: z.string().max(80).optional(),
        source: z.string().max(200).optional(),
        role: z.string().max(80).optional(),
        hidden: z.boolean(),
        ariaHidden: z.boolean().default(false),
        bounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number().nonnegative(),
          height: z.number().nonnegative(),
        }),
        overflowX: z.boolean(),
        overflowY: z.boolean(),
        styles: z
          .record(z.string().max(80), z.string().max(200))
          .refine((value) => Object.keys(value).length <= 30),
      }),
    )
    .max(5000),
});

export const maxUploadBytes = 8 * 1024 * 1024;
export const maxScreenshotBytes = 3 * 1024 * 1024;
export const maxScreenshotPixels = 6_000_000;
export const maxSnapshotBytes = 512 * 1024;
export const maxCiCheckpoints = 20;

export const ciCaptureSchema = z.strictObject({
  key: captureKey,
  route: routePath,
  identity: sha256,
  metadata: captureMetadata,
  image: z.base64().max(Math.ceil(maxScreenshotBytes / 3) * 4),
  snapshot: z
    .base64()
    .max(Math.ceil(maxSnapshotBytes / 3) * 4)
    .optional(),
});
export const ciRunSchema = z.strictObject({
  commit: commitSha.transform((value) => value.toLowerCase()),
  branch: branchName,
  captures: z.array(ciCaptureSchema).min(1).max(maxCiCheckpoints),
});
export type CiRunUpload = z.input<typeof ciRunSchema>;
