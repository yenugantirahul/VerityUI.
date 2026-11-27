import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { digestOf } from '../persistence/artifacts.ts';
import {
  branchName,
  captureKey,
  captureMetadata,
  ciRunSchema,
  commitSha,
  maxCiCheckpoints,
  maxScreenshotBytes,
  maxSnapshotBytes,
  maxUploadBytes,
  routePath,
  sha256,
  type CiRunUpload,
} from '../verification/contract.ts';

const manifestSchema = z.object({
  version: z.literal(1),
  commit: commitSha.nullish(),
  captures: z
    .array(
      z.object({
        key: captureKey,
        route: routePath,
        identity: sha256,
        sha256,
        snapshotHash: sha256.optional(),
        metadata: captureMetadata,
      }),
    )
    .min(1)
    .max(maxCiCheckpoints),
});

async function captureFile(path: string, expected: string, limit: number) {
  const file = await stat(path);
  if (!file.isFile() || file.size > limit)
    throw new Error('A bundle artifact exceeded its upload limit');
  const bytes = await readFile(path);
  if (digestOf(bytes) !== expected || bytes.length > limit)
    throw new Error('A bundle artifact failed its integrity check');
  return bytes.toString('base64');
}

export async function uploadBundle(options: {
  api?: string;
  input?: string;
  branch?: string;
  commit?: string;
  key?: string;
  wait?: boolean;
}) {
  const token = process.env.VERITYUI_CI_TOKEN;
  if (!token || !/^vui_ci_[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('Set VERITYUI_CI_TOKEN to a project CI credential');
  const origin = URL.parse(
    options.api ?? process.env.VERITYUI_API_URL ?? 'http://127.0.0.1:4310',
  );
  const loopback =
    origin?.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    !origin ||
    (!loopback && origin.protocol !== 'https:') ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error('Use an HTTPS API origin or loopback HTTP');
  if (!options.input)
    throw new Error('Upload needs --input pointing to a capture bundle');
  const directory = resolve(options.input);
  const file = join(directory, 'reference.json');
  if ((await stat(file)).size > 128 * 1024)
    throw new Error('Capture manifest exceeds its upload limit');
  const manifest = manifestSchema.safeParse(
    JSON.parse(await readFile(file, 'utf8')),
  );
  if (!manifest.success)
    throw new Error(
      'Upload needs an application capture bundle with at most 20 checkpoints',
    );
  const branch = branchName.safeParse(
    options.branch ??
      (process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME),
  );
  const commit = commitSha.safeParse(
    manifest.data.commit ?? options.commit ?? process.env.GITHUB_SHA,
  );
  if (
    !branch.success ||
    !commit.success ||
    (options.commit &&
      options.commit.toLowerCase() !== commit.data.toLowerCase())
  )
    throw new Error(
      'Supply a branch and commit that match the captured revision',
    );
  const captures: CiRunUpload['captures'] = [];
  let encodedBytes = 0;
  for (const {
    key,
    route,
    identity,
    metadata,
    sha256,
    snapshotHash,
  } of manifest.data.captures) {
    const image = await captureFile(
      join(directory, `${key}.png`),
      sha256,
      maxScreenshotBytes,
    );
    const snapshot =
      snapshotHash &&
      (await captureFile(
        join(directory, `${key}-dom.json`),
        snapshotHash,
        maxSnapshotBytes,
      ));
    encodedBytes += image.length + (snapshot?.length ?? 0);
    if (encodedBytes > maxUploadBytes)
      throw new Error('The capture bundle exceeds the 8 MiB upload limit');
    captures.push({ key, route, identity, metadata, image, snapshot });
  }
  const payload = ciRunSchema.parse({
    branch: branch.data,
    commit: commit.data,
    captures,
  });
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxUploadBytes)
    throw new Error('The capture bundle exceeds the 8 MiB upload limit');
  const key = options.key ?? digestOf(Buffer.from(body));
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new Error('Invalid CI idempotency key');
  const root = new URL('/api/v1/ci/runs', origin);
  async function request(url: URL, submission?: string) {
    const response = await fetch(url, {
      method: submission ? 'POST' : 'GET',
      body: submission,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(submission
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': key }
          : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message = z
        .object({ error: z.string().max(300) })
        .safeParse(payload);
      throw new Error(
        message.success
          ? message.data.error
          : `CI API request failed with HTTP ${response.status}`,
      );
    }
    return payload;
  }
  const { id, projectId } = z
    .object({ id: z.uuid(), projectId: z.uuid() })
    .parse(await request(root, body));
  const dashboard = new URL('/', origin);
  dashboard.searchParams.set('project', projectId);
  dashboard.searchParams.set('run', id);
  let status: 'pending' | 'passed' | 'review_required' | 'inconclusive' =
    'pending';
  if (options.wait) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && status === 'pending') {
      const result = z
        .object({
          status: z.enum([
            'pending',
            'passed',
            'review_required',
            'inconclusive',
          ]),
        })
        .parse(await request(new URL(`${root.href}/${id}`)));
      status = result.status;
      if (status === 'pending') await delay(1200);
    }
  }
  console.log(
    JSON.stringify({ id, projectId, status, dashboard: dashboard.href }),
  );
  return status === 'review_required'
    ? 2
    : status === 'inconclusive' || (options.wait && status === 'pending')
      ? 3
      : 0;
}
