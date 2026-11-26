import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { startFixture as StartFixture } from '../src/fixture/server.ts';

const config = 'examples/analytics/verityui.config.json';
const base = process.env.FIXTURE_BASE_CHECKOUT ?? '.';
const referenceCommit = process.env.REFERENCE_SHA;
const currentCommit = process.env.CANDIDATE_SHA ?? process.env.GITHUB_SHA;
const variant = process.env.FIXTURE_VARIANT === 'color' ? 'color' : 'original';
const reportRoot = process.env.VERITYUI_OUTPUT_DIRECTORY ?? '.';
const baselineOutput = join(reportRoot, 'visual-reference');
const verificationOutput = join(reportRoot, 'visual-report');

async function fixtureAt(
  directory: string,
  selected?: Parameters<typeof StartFixture>[0],
) {
  const { startFixture } = (await import(
    pathToFileURL(resolve(directory, 'dist/fixture/server.js')).href
  )) as {
    startFixture: typeof StartFixture;
  };
  return startFixture(selected);
}

function cli(
  command: string,
  origin: string,
  commit: string | undefined,
  extra: string[],
) {
  return new Promise<number>((resolveCode, reject) => {
    const args = [
      'dist/cli/main.js',
      command,
      '--config',
      config,
      '--base-url',
      origin,
      ...extra,
    ];
    if (commit) args.push('--commit', commit);
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolveCode(code ?? 3));
  });
}

const reference = await fixtureAt(base);
try {
  process.exitCode = await cli('capture', reference.origin, referenceCommit, [
    '--output',
    baselineOutput,
  ]);
} finally {
  await reference.close();
}
if (process.exitCode === 0) {
  const candidate = await fixtureAt('.', variant);
  try {
    process.exitCode = await cli('verify', candidate.origin, currentCommit, [
      '--reference',
      baselineOutput,
      '--output',
      verificationOutput,
    ]);
  } finally {
    await candidate.close();
  }
}
