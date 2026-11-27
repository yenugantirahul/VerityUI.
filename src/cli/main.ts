#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { capture, type CaptureResult } from '../capture/engine.ts';
import {
  CaptureError,
  desktopProfile,
  type CaptureRequest,
} from '../capture/policy.ts';
import type { Snapshot } from '../capture/snapshot.ts';
import { compareScreenshots } from '../compare/compare.ts';
import { cropEvidence } from '../compare/crops.ts';
import { compareStructure } from '../compare/structure.ts';
import { inspectDashboard } from '../fixture/assertions.ts';
import { fixtureVariants, fixtureVersion } from '../fixture/page.ts';
import { startFixture } from '../fixture/server.ts';
import { digestOf } from '../persistence/artifacts.ts';
import { baselineIdentity } from '../persistence/baselines.ts';
import { evaluateIntent, readIntent } from '../verification/intent.ts';
import { createVisionAnalyzer } from '../verification/vision.ts';
import { commitSha, sha256, snapshotSchema } from '../verification/contract.ts';
import { applicationPath, readConfig, safeKey } from './config.ts';
import { renderReport, type Report, type ReportResult } from './report.ts';
import { uploadBundle } from './upload.ts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const referenceEntry = z.object({
  key: z.string().regex(safeKey),
  identity: sha256,
  sha256,
  snapshotHash: sha256.optional(),
  route: applicationPath.optional(),
  viewport: z.string().regex(safeKey).optional(),
});
type Reference = z.output<typeof referenceEntry>;

async function loadReference(directory: string) {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(directory, 'reference.json'), 'utf8'),
    );
    const parsed = z
      .object({
        version: z.literal(1),
        commit: commitSha.nullish(),
        captures: z.array(referenceEntry).min(1).max(80),
      })
      .safeParse(manifest);
    if (
      !parsed.success ||
      new Set(parsed.data.captures.map(({ key }) => key.toLowerCase())).size !==
        parsed.data.captures.length
    )
      throw new Error('Invalid reference manifest');
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function jsonBytes(body: unknown) {
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
}

async function readCapture(directory: string, entry: Reference) {
  const png = await readFile(join(directory, `${entry.key}.png`));
  if (digestOf(png) !== entry.sha256)
    throw new Error(`Reference integrity check failed for ${entry.key}`);
  if (!entry.snapshotHash) return { png };
  const bytes = await readFile(join(directory, `${entry.key}-dom.json`));
  if (digestOf(bytes) !== entry.snapshotHash || bytes.length > 12 * 1024 * 1024)
    throw new Error(
      `Structural evidence integrity check failed for ${entry.key}`,
    );
  const snapshot = snapshotSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!snapshot.success)
    throw new Error(`Invalid structural evidence for ${entry.key}`);
  return { png, snapshot: snapshot.data };
}

async function defaultConfig() {
  const file = 'verityui.config.json';
  try {
    await access(file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return 'deltaframe.config.json';
    throw error;
  }
}

function checkpoints(
  config: Awaited<ReturnType<typeof readConfig>>,
  origin?: string,
): {
  key: string;
  route?: string;
  viewport?: string;
  request: CaptureRequest;
}[] {
  if (config.version === 2)
    return config.requests.map(({ path, viewportKey, request }) => ({
      key: `${digestOf(Buffer.from(path)).slice(0, 16)}-${viewportKey}`,
      route: path,
      viewport: viewportKey,
      request,
    }));
  if (!origin) throw new Error('Fixture origin is missing');
  return config.checkpoints.map(
    ({ key, width, height, browser, selector, masks }) => ({
      key,
      request: {
        origin,
        profile: {
          ...desktopProfile,
          browser: browser ?? desktopProfile.browser,
          viewport: { width, height },
        },
        target: {
          path: '/analytics',
          readySelector: 'main[data-ready]',
          selector,
          masks,
        },
      },
    }),
  );
}

async function writeJson(file: string, body: unknown) {
  await writeFile(file, jsonBytes(body), { flag: 'wx' });
}

async function review(
  values: Partial<Record<'project' | 'run' | 'job' | 'action' | 'api', string>>,
) {
  const token =
    process.env.VERITYUI_API_TOKEN ?? process.env.DELTAFRAME_API_TOKEN;
  const ids = [values.project, values.run, values.job];
  if (
    !token ||
    !ids.every((id) => id && uuid.test(id)) ||
    !['approve', 'reject'].includes(values.action ?? '')
  ) {
    throw new Error(
      'Review needs VERITYUI_API_TOKEN and valid --project, --run, --job and --action options',
    );
  }
  const target = new URL(values.api ?? 'http://127.0.0.1:4310');
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.href !== `${target.origin}/`
  )
    throw new Error('Review API must be a loopback origin');
  const project = `${target.origin}/api/v1/projects/${values.project}`;
  async function request(path: string, body?: unknown) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    const payload = (await response.json()) as { id?: string; error?: string };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Review request failed with HTTP ${response.status}`,
      );
    return payload;
  }
  const candidate = await request(
    `${project}/runs/${values.run}/jobs/${values.job}/candidate`,
  );
  if (!candidate.id || !uuid.test(candidate.id))
    throw new Error('The API did not return a valid candidate');
  console.log(
    JSON.stringify(
      await request(`${project}/baselines/${candidate.id}/review`, {
        action: values.action,
      }),
    ),
  );
}

async function execute() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      output: { type: 'string' },
      reference: { type: 'string' },
      current: { type: 'string' },
      variant: { type: 'string' },
      commit: { type: 'string' },
      'base-url': { type: 'string' },
      ai: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      api: { type: 'string' },
      input: { type: 'string' },
      branch: { type: 'string' },
      key: { type: 'string' },
      wait: { type: 'boolean' },
      project: { type: 'string' },
      run: { type: 'string' },
      job: { type: 'string' },
      action: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values.help || positionals.length === 0) {
    console.log(
      'verityui init | capture | verify | compare | upload | report | review\n\n' +
        '  init     [--config verityui.config.json] [--base-url http://localhost:3000]\n' +
        '  capture [--config FILE] [--base-url URL] [--output DIR] [--commit SHA]\n' +
        '  verify  --reference DIR [--config FILE] [--base-url URL] [--output DIR] [--ai]\n' +
        '  compare --reference DIR --current DIR [--config FILE] [--output DIR] [--ai]\n' +
        '  upload   --input DIR [--api URL] [--branch NAME] [--commit SHA] [--wait]\n' +
        '  report   --output DIR\n' +
        '  review  --project ID --run ID --job ID --action approve|reject [--api URL]',
    );
    return;
  }
  if (
    positionals.length !== 1 ||
    ![
      'init',
      'capture',
      'run',
      'verify',
      'compare',
      'upload',
      'report',
      'review',
    ].includes(command!)
  )
    throw new Error('Unknown command. Run verityui --help for usage.');
  if (command === 'review') {
    await review(values);
    return;
  }
  if (command === 'upload') {
    process.exitCode = await uploadBundle(values);
    return;
  }
  if (command === 'report') {
    if (!values.output) throw new Error('The report command needs --output');
    const dir = resolve(values.output);
    const html = join(dir, 'report.html');
    if (!(await stat(html)).isFile()) throw new Error('HTML report is missing');
    const report = join(dir, 'report.json');
    const { status, results } = z
      .object({
        status: z.enum([
          'failed',
          'review_required',
          'inconclusive',
          'reference_created',
          'passed',
        ]),
        results: z.array(z.object({ key: z.string() })),
      })
      .parse(JSON.parse(await readFile(report, 'utf8')));
    console.log(
      JSON.stringify({ status, checkpoints: results.length, report, html }),
    );
    return;
  }
  if (command === 'init') {
    const file = resolve(values.config ?? 'verityui.config.json');
    const baseURL = URL.parse(values['base-url'] ?? 'http://localhost:3000');
    if (
      !baseURL ||
      !['http:', 'https:'].includes(baseURL.protocol) ||
      baseURL.href !== `${baseURL.origin}/`
    )
      throw new Error('Use an HTTP(S) origin for --base-url');
    await writeJson(file, {
      version: 2,
      baseURL: baseURL.origin,
      routes: ['/'],
      viewports: [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ],
      capture: { disableAnimations: true, waitForFonts: true },
      verification: { mode: 'review', autoApprove: false },
    });
    console.log(JSON.stringify({ status: 'configured', config: file }));
    return;
  }
  const configFile = resolve(values.config ?? (await defaultConfig()));
  const config = await readConfig(
    configFile,
    values['base-url'],
    command === 'compare',
  );
  const appConfig = config.version === 2 ? config : undefined;
  if (appConfig && values.variant)
    throw new Error('--variant is only for the fixture');
  if (command === 'compare' && (!appConfig || !values.current))
    throw new Error(
      'Offline compare needs an application config and --current',
    );
  if (command !== 'compare' && values.current)
    throw new Error('--current is only for offline compare');
  if (values.ai && (command === 'capture' || !appConfig))
    throw new Error('--ai requires an application verification');
  const intent = appConfig?.verification?.intent
    ? await readIntent(
        resolve(dirname(configFile), appConfig.verification.intent),
      )
    : undefined;
  const variant = fixtureVariants.find(
    (name) => name === (values.variant ?? 'original'),
  );
  if (!variant) throw new Error('Unknown fixture variant');
  const output = resolve(
    values.output ?? join('data', 'cli', `${command}-${Date.now()}`),
  );
  const referenceDirectory = values.reference
    ? resolve(values.reference)
    : undefined;
  const currentDirectory = values.current ? resolve(values.current) : undefined;
  if ((command !== 'capture') !== Boolean(referenceDirectory))
    throw new Error(
      'Verification requires --reference. Capture creates a standalone reference.',
    );
  if (referenceDirectory === output || currentDirectory === output)
    throw new Error('Use a new output directory for the report');
  const reference = referenceDirectory
    ? await loadReference(referenceDirectory)
    : undefined;
  const currentBundle = currentDirectory
    ? await loadReference(currentDirectory)
    : undefined;
  if (currentDirectory && !currentBundle)
    throw new Error('Current capture bundle is missing');
  if (
    values.commit &&
    currentBundle?.commit &&
    values.commit !== currentBundle.commit
  )
    throw new Error('Commit does not match the current capture bundle');
  const commit =
    currentBundle?.commit ?? values.commit ?? process.env.GITHUB_SHA ?? null;
  if (commit && !commitSha.safeParse(commit).success)
    throw new Error('Commit must be a 40-character hash');
  const fixture = appConfig ? undefined : await startFixture(variant);
  const captures: (Reference & { metadata?: CaptureResult['metadata'] })[] = [];
  const results: ReportResult[] = [];
  const classify = values.ai ? createVisionAnalyzer(process.env) : undefined;
  try {
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    const matrix = checkpoints(config, fixture?.origin);
    if (appConfig) {
      const keys = new Set(matrix.map(({ key }) => key));
      for (const { key, route, viewport } of reference?.captures ?? []) {
        if (route && !keys.has(key))
          results.push({
            key,
            route,
            viewport,
            evidence: [],
            checks: [],
            failure:
              'This baseline route and viewport are absent from the current configuration.',
          });
      }
    }
    for (const { key, request, route, viewport } of matrix) {
      const result: ReportResult = {
        key,
        route,
        viewport,
        checks: [],
        evidence: [],
      };
      results.push(result);
      let current: { png: Buffer; snapshot?: Snapshot };
      let entry: Reference & { metadata?: CaptureResult['metadata'] };
      if (currentDirectory && currentBundle) {
        const match = currentBundle.captures.find(
          (candidate) =>
            candidate.key === key &&
            candidate.route === route &&
            candidate.viewport === viewport,
        );
        if (!match) {
          result.failure =
            'This route and viewport are missing from the current capture bundle.';
          continue;
        }
        entry = match;
        current = await readCapture(currentDirectory, match);
      } else {
        try {
          const captured = await capture(
            request,
            fixture
              ? async (page, budget) => {
                  result.checks = await inspectDashboard(page, budget);
                }
              : undefined,
          );
          current = captured;
          entry = {
            key,
            route,
            viewport,
            sha256: captured.metadata.sha256,
            metadata: captured.metadata,
            identity: baselineIdentity({
              environment: fixture ? 'cli-fixture' : 'cli-application',
              checkpoint: key,
              fixtureVersion: fixture
                ? fixtureVersion
                : `1:random=${request.randomSeed ?? 'default'}`,
              target: request.target,
              jsonFixtures: request.jsonFixtures,
              authenticationProfile: request.storageState
                ? 'storage-state'
                : undefined,
              metadata: captured.metadata,
            }),
          };
        } catch (error) {
          if (!(error instanceof CaptureError)) throw error;
          result.failure = error.message;
          continue;
        }
      }
      const currentName = `${key}.png`;
      await writeFile(join(output, currentName), current.png, { flag: 'wx' });
      result.evidence.push(currentName);
      if (current.snapshot) {
        const snapshot = jsonBytes(current.snapshot);
        const name = `${key}-dom.json`;
        entry.snapshotHash = digestOf(snapshot);
        await writeFile(join(output, name), snapshot, { flag: 'wx' });
        result.evidence.push(name);
        const artifacts = {
          accessibility: current.snapshot.nodes.flatMap(
            ({ path, role, hidden, ariaHidden }) =>
              role ? [{ path, role, hidden: hidden || ariaHidden }] : [],
          ),
          styles: current.snapshot.nodes.map(({ path, styles }) => ({
            path,
            styles,
          })),
          ...(entry.metadata
            ? {
                metadata: entry.metadata,
                'network-summary': {
                  blockedRequests: entry.metadata.blockedRequests,
                },
              }
            : {}),
        };
        for (const [kind, data] of Object.entries(artifacts)) {
          const name = `${key}-${kind}.json`;
          await writeJson(join(output, name), data);
          result.evidence.push(name);
        }
      }
      captures.push(entry);
      if (command === 'capture') continue;
      const match = reference?.captures.find(
        (candidate) =>
          candidate.key === key && candidate.identity === entry.identity,
      );
      const baseline =
        match && referenceDirectory
          ? await readCapture(referenceDirectory, match)
          : undefined;
      const compared = compareScreenshots(
        baseline?.png,
        current.png,
        config.comparison,
      );
      result.comparison = compared.summary;
      if (baseline) {
        const path = `${key}-baseline.png`;
        await writeFile(join(output, path), baseline.png, { flag: 'wx' });
        result.evidence.push(path);
      }
      for (const [kind, data] of Object.entries(compared.artifacts ?? {})) {
        const path = `${key}-${kind}.png`;
        await writeFile(join(output, path), data, { flag: 'wx' });
        result.evidence.push(path);
      }
      if (appConfig && route) {
        const critical = appConfig.criticalRoutes?.includes(route) ?? false;
        if (baseline?.snapshot && current.snapshot)
          result.structure = compareStructure(
            baseline.snapshot,
            current.snapshot,
            compared.summary.regions,
          );
        result.intent = evaluateIntent(
          route,
          critical,
          compared.summary,
          result.structure,
          intent,
        );
        const crops = baseline
          ? cropEvidence(baseline.png, current.png, compared.summary.regions)
          : [];
        for (const crop of crops) {
          for (const kind of ['baseline', 'current'] as const) {
            const path = `${key}-${crop.id}-${kind}.png`;
            await writeFile(join(output, path), crop[kind], { flag: 'wx' });
            result.evidence.push(path);
          }
        }
        if (classify && compared.summary.changedPixels)
          result.analysis = await classify({
            route,
            critical,
            intent: intent?.description,
            structure: result.structure,
            crops,
          });
      }
    }
  } finally {
    await fixture?.close();
  }

  const inconclusive = results.some(({ failure }) => Boolean(failure));
  const failed = results.some(
    ({ comparison, checks, intent }) =>
      checks.some((check) => !check.passed) ||
      (appConfig
        ? appConfig.verification?.mode === 'strict' &&
          intent?.verdict === 'needs_review'
        : comparison?.status === 'changed' ||
          comparison?.status === 'incompatible'),
  );
  const reviewNeeded = results.some(
    ({ comparison, intent }) =>
      comparison?.status === 'missing' ||
      (intent && ['within_intent', 'needs_review'].includes(intent.verdict)),
  );
  const status = inconclusive
    ? 'inconclusive'
    : failed
      ? 'failed'
      : reviewNeeded
        ? 'review_required'
        : command === 'capture'
          ? 'reference_created'
          : 'passed';
  if (status === 'reference_created')
    await writeJson(join(output, 'reference.json'), {
      version: 1,
      commit,
      captures,
    });
  const report: Report = {
    version: 1,
    commit,
    baselineCommit: reference?.commit ?? undefined,
    status,
    variant: fixture ? variant : undefined,
    results,
  };
  await writeJson(join(output, 'report.json'), report);
  await writeFile(join(output, 'report.html'), renderReport(report), {
    flag: 'wx',
  });
  console.log(JSON.stringify({ status, report: join(output, 'report.json') }));
  process.exitCode = inconclusive ? 3 : failed ? 1 : reviewNeeded ? 2 : 0;
}

try {
  await execute();
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : 'CLI execution failed',
    }),
  );
  process.exitCode = 3;
}
