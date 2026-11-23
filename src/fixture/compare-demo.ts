import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { capture } from '../capture/engine.ts';
import { desktopProfile } from '../capture/policy.ts';
import { compareScreenshots } from '../compare/compare.ts';
import { fixtureVariants } from './page.ts';
import { startFixture } from './server.ts';

const input = process.argv[2] ?? 'color';
const variant = fixtureVariants.find((value) => value === input);
if (!variant || variant === 'loading' || variant === 'tall') {
  throw new Error(
    'Choose original, color, missing, shift, overflow, clipped, typography or cosmetic.',
  );
}
const benchmark = process.argv[3] === '--benchmark';
const fixture = await startFixture();
try {
  const request = {
    origin: fixture.origin,
    profile: desktopProfile,
    target: { path: '/analytics', readySelector: 'main[data-ready="true"]' },
  };
  const baseline = await capture(request);
  fixture.selectVariant(variant);
  const current = await capture(request);
  const result = compareScreenshots(baseline.png, current.png);
  const directory = resolve('data', 'demo', variant);
  await mkdir(directory, { recursive: true });
  const files = {
    baseline: baseline.png,
    current: current.png,
    ...result.artifacts,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(directory, `${name}.png`), content);
  }
  await writeFile(
    resolve(directory, 'comparison.json'),
    `${JSON.stringify(result.summary, null, 2)}\n`,
  );
  console.log(
    `${result.summary.status} · ${result.summary.message}\n${directory}`,
  );

  if (benchmark) {
    const samples = Array.from({ length: 30 }, () => {
      const start = performance.now();
      compareScreenshots(baseline.png, current.png);
      return performance.now() - start;
    }).sort((left, right) => left - right);
    console.log(
      JSON.stringify(
        {
          samples: samples.length,
          input: result.summary.current,
          p50Ms: Math.round(samples[Math.ceil(samples.length * 0.5) - 1]!),
          p95Ms: Math.round(samples[Math.ceil(samples.length * 0.95) - 1]!),
          processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        },
        null,
        2,
      ),
    );
  }
} finally {
  await fixture.close();
}
