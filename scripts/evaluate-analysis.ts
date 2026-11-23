import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  analysisVersion,
  diagnose,
  type Classification,
} from '../src/analysis/diagnose.ts';
import { capture } from '../src/capture/engine.ts';
import { desktopProfile } from '../src/capture/policy.ts';
import { compareScreenshots } from '../src/compare/compare.ts';
import type { Region } from '../src/compare/regions.ts';
import type { FixtureVariant } from '../src/fixture/page.ts';
import { startFixture } from '../src/fixture/server.ts';

const cases: {
  name: FixtureVariant;
  label: Classification;
  widget: string;
  critical?: boolean;
}[] = [
  { name: 'original', label: 'identical', widget: 'main' },
  { name: 'cosmetic', label: 'minor', widget: '.chart h2' },
  { name: 'color', label: 'color', widget: '.plot' },
  {
    name: 'missing',
    label: 'removed',
    widget: '[data-kpi="sessions"]',
    critical: true,
  },
  { name: 'shift', label: 'layout', widget: '.chart' },
  { name: 'overflow', label: 'layout', widget: '.plot', critical: true },
  { name: 'clipped', label: 'clipped', widget: '.plot', critical: true },
  { name: 'typography', label: 'text', widget: '.kpis' },
  {
    name: 'wrong_value',
    label: 'text',
    widget: '[data-kpi="revenue"]',
    critical: true,
  },
];
const viewports = [
  { width: 1200, height: 800 },
  { width: 430, height: 800 },
  { width: 1600, height: 960 },
];
const fixture = await startFixture();
const browser = await chromium.launch({ channel: 'chromium' });

type Rect = Pick<Region, 'x' | 'y' | 'width' | 'height'>;
function coverage(box: Rect, truth: Rect) {
  const width = Math.max(
    0,
    Math.min(box.x + box.width, truth.x + truth.width) -
      Math.max(box.x, truth.x),
  );
  const height = Math.max(
    0,
    Math.min(box.y + box.height, truth.y + truth.height) -
      Math.max(box.y, truth.y),
  );
  return (width * height) / (box.width * box.height);
}

const measurements: {
  fixture: string;
  viewport: number;
  label: Classification;
  prediction: Classification;
  detected: boolean;
  critical: boolean;
  elapsedMs: number;
  containment: number | null;
  evidenceValid: boolean;
}[] = [];
try {
  const page = await browser.newPage();
  const target = {
    path: '/analytics',
    readySelector: 'main[data-ready="true"]',
  };
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const request = {
      origin: fixture.origin,
      profile: { ...desktopProfile, viewport },
      target,
    };
    fixture.selectVariant('original');
    const baseline = await capture(request);
    await page.goto(`${fixture.origin}${target.path}`);
    await page.locator(target.readySelector).waitFor({ state: 'visible' });
    const boxes = new Map<string, Rect | null>();
    for (const item of cases)
      boxes.set(item.name, await page.locator(item.widget).boundingBox());
    for (const item of cases) {
      fixture.selectVariant(item.name);
      const current = await capture(request);
      const comparison = compareScreenshots(baseline.png, current.png);
      const started = performance.now();
      const analysis = diagnose(baseline.png, current.png, comparison);
      const elapsedMs = performance.now() - started;
      if (analysis.state !== 'available')
        throw new Error('Expected an analysis for comparable evidence');
      const { summary } = comparison;
      const primary = summary.regions[0];
      const truth = boxes.get(item.name);
      measurements.push({
        fixture: item.name,
        viewport: viewport.width,
        label: item.label,
        prediction: analysis.classification,
        detected:
          summary.status === 'changed' || summary.status === 'incompatible',
        critical: item.critical ?? false,
        elapsedMs,
        containment: truth && primary ? coverage(primary, truth) : null,
        evidenceValid:
          analysis.evidence.changedPixels === (summary.changedPixels ?? 0) &&
          analysis.regionIndexes.every(
            (index) => summary.regions[index] !== undefined,
          ) &&
          analysis.evidence.inspectedPixels === (summary.changedPixels ?? 0),
      });
    }
    fixture.selectVariant('original');
    const masked = {
      ...request,
      target: { ...target, path: '/analytics?dynamic=1', masks: ['.dynamic'] },
    };
    const dynamicBaseline = await capture(masked);
    const dynamicCurrent = await capture(masked);
    const comparison = compareScreenshots(
      dynamicBaseline.png,
      dynamicCurrent.png,
    );
    const started = performance.now();
    const analysis = diagnose(
      dynamicBaseline.png,
      dynamicCurrent.png,
      comparison,
    );
    if (analysis.state !== 'available')
      throw new Error('Masked capture must support analysis');
    measurements.push({
      fixture: 'masked-dynamic',
      viewport: viewport.width,
      label: 'identical',
      prediction: analysis.classification,
      detected: comparison.summary.status !== 'matched',
      critical: false,
      elapsedMs: performance.now() - started,
      containment: null,
      evidenceValid:
        analysis.evidence.inspectedPixels === 0 &&
        !analysis.regionIndexes.length,
    });
  }
} finally {
  await browser.close();
  await fixture.close();
}

function metrics(
  rows: typeof measurements,
  expected: (row: (typeof measurements)[number]) => boolean,
  predicted: (row: (typeof measurements)[number]) => boolean,
) {
  const tp = rows.filter((row) => expected(row) && predicted(row)).length;
  const fp = rows.filter((row) => !expected(row) && predicted(row)).length;
  const fn = rows.filter((row) => expected(row) && !predicted(row)).length;
  const tn = rows.length - tp - fp - fn;
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp / (tp + fp || 1),
    recall: tp / (tp + fn || 1),
    f1: (2 * tp) / (2 * tp + fp + fn || 1),
    falsePositiveRate: fp / (fp + tn || 1),
    falseNegativeRate: fn / (tp + fn || 1),
  };
}

const validation = measurements.filter(({ viewport }) => viewport !== 1200);
const positive = ({ label }: (typeof measurements)[number]) =>
  label !== 'minor' && label !== 'identical';
const defectLabels = [...new Set(cases.map(({ label }) => label))];
const diagnostic = defectLabels.map((label) => ({
  label,
  ...metrics(
    validation,
    (row) => row.label === label,
    (row) => row.prediction === label,
  ),
}));
const baselineDiagnostic = defectLabels.map((label) =>
  metrics(
    validation,
    (row) => row.label === label,
    (row) => !row.detected && label === 'identical',
  ),
);
const p95 = validation.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b)[
  Math.ceil(validation.length * 0.95) - 1
];
const localized = validation.flatMap(({ containment }) =>
  containment === null ? [] : [containment],
);
const report = {
  version: analysisVersion,
  evaluated: measurements.length,
  heldOut: validation.length,
  deterministicDetection: metrics(validation, positive, (row) => row.detected),
  diagnostic,
  macroF1: diagnostic.reduce((sum, row) => sum + row.f1, 0) / diagnostic.length,
  deterministicMacroF1:
    baselineDiagnostic.reduce((sum, row) => sum + row.f1, 0) /
    baselineDiagnostic.length,
  criticalMisses: validation.filter((row) => row.critical && !row.detected)
    .length,
  evidenceChecks: validation.filter(({ evidenceValid }) => evidenceValid)
    .length,
  meanPrimaryRegionContainment:
    localized.reduce((sum, value) => sum + value, 0) / (localized.length || 1),
  localized: localized.length,
  incrementalP95Ms: Math.round(p95 ?? 0),
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
};
const directory = resolve('data', 'evaluation');
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, 'diagnostics.json'),
  `${JSON.stringify({ ...report, measurements }, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
