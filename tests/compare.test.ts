import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { capture } from '../src/capture/engine.ts';
import { desktopProfile } from '../src/capture/policy.ts';
import { compareScreenshots } from '../src/compare/compare.ts';
import { InvalidImageError } from '../src/compare/images.ts';
import { startFixture } from '../src/fixture/server.ts';

function image(
  width: number,
  height: number,
  changes: readonly [number, number][] = [],
) {
  const png = new PNG({ width, height });
  const data = png.data.fill(255);
  for (const [x, y] of changes) {
    data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return PNG.sync.write(png);
}

test('comparison reports compatible, missing and dimension-changing baselines', () => {
  const original = image(40, 40);
  const matched = compareScreenshots(original, original).summary;
  assert.equal(matched.status, 'matched');
  assert.equal(matched.changedPixels, 0);
  assert.deepEqual(matched.regions, []);
  assert.equal(
    compareScreenshots(undefined, original).summary.status,
    'missing',
  );
  const incompatible = compareScreenshots(original, image(42, 40)).summary;
  assert.equal(incompatible.status, 'incompatible');
  assert.deepEqual(incompatible.baseline, { width: 40, height: 40 });
  assert.deepEqual(incompatible.current, { width: 42, height: 40 });
  assert.equal(incompatible.changedPixels, undefined);
});

test('comparison localizes precise changed pixels and emits dimensionally valid evidence', () => {
  const baseline = image(64, 64);
  const current = image(64, 64, [
    [3, 5],
    [4, 6],
    [48, 52],
  ]);
  const { artifacts, summary } = compareScreenshots(baseline, current);
  assert.equal(summary.status, 'changed');
  assert.equal(summary.changedPixels, 3);
  assert.equal(summary.changedRatio, 3 / 4096);
  assert.deepEqual(summary.regions, [
    { x: 3, y: 5, width: 2, height: 2, changedPixels: 2 },
    { x: 48, y: 52, width: 1, height: 1, changedPixels: 1 },
  ]);
  assert.ok(artifacts);
  const diff = PNG.sync.read(artifacts.diff);
  const heatmap = PNG.sync.read(artifacts.heatmap);
  const overlay = PNG.sync.read(artifacts.overlay);
  for (const evidence of [diff, heatmap, overlay]) {
    assert.equal(evidence.width, 64);
    assert.equal(evidence.height, 64);
  }
  const changedOffset = (5 * 64 + 3) * 4;
  assert.deepEqual(
    [...diff.data.subarray(changedOffset, changedOffset + 4)],
    [222, 22, 99, 255],
  );
  assert.ok(heatmap.data[changedOffset]! > heatmap.data[changedOffset + 1]!);
  assert.deepEqual(
    [...overlay.data.subarray(changedOffset, changedOffset + 4)],
    [128, 128, 128, 255],
  );
  for (const settings of [
    { maxChangedPixels: 3 },
    { maxChangedRatio: 0.001 },
  ]) {
    const tolerated = compareScreenshots(baseline, current, settings);
    assert.equal(tolerated.summary.status, 'matched');
    assert.equal(tolerated.summary.changedPixels, 3);
    assert.ok(tolerated.artifacts);
  }
});

test('comparison rejects corrupt images, unsafe dimensions and invalid policies', () => {
  const valid = image(10, 10);
  const large = Buffer.from(valid);
  large.writeUInt32BE(1_000_000, 16);
  const interlaced = Buffer.from(valid);
  interlaced[28] = 1;
  assert.throws(() => compareScreenshots(undefined, large), InvalidImageError);
  assert.throws(
    () => compareScreenshots(undefined, interlaced),
    /non-interlaced/,
  );
  assert.throws(
    () => compareScreenshots(valid.subarray(0, 40), valid),
    InvalidImageError,
  );
  assert.throws(
    () => compareScreenshots(valid, Buffer.from('not a png')),
    InvalidImageError,
  );
  assert.throws(
    () => compareScreenshots(valid, valid, { maxChangedRatio: 1.01 }),
    RangeError,
  );
  assert.throws(
    () => compareScreenshots(valid, valid, { pixelThreshold: Number.NaN }),
    RangeError,
  );
});

test(
  'browser screenshots flag seeded dashboard defects and tolerate a subtle text tint',
  { timeout: 45_000 },
  async (context) => {
    const fixture = await startFixture();
    context.after(() => fixture.close());
    const request = {
      origin: fixture.origin,
      profile: desktopProfile,
      target: { path: '/analytics', readySelector: 'main[data-ready="true"]' },
    };
    const baseline = (await capture(request)).png;
    assert.equal(
      compareScreenshots(baseline, (await capture(request)).png).summary.status,
      'matched',
    );
    for (const variant of [
      'color',
      'missing',
      'shift',
      'overflow',
      'clipped',
      'typography',
    ] as const) {
      fixture.selectVariant(variant);
      const current = (await capture(request)).png;
      const result = compareScreenshots(baseline, current);
      if (variant === 'overflow') {
        assert.equal(result.summary.status, 'incompatible', variant);
      } else {
        assert.equal(result.summary.status, 'changed', variant);
        assert.ok(result.summary.regions.length > 0, variant);
        assert.ok(result.artifacts, variant);
      }
    }
    fixture.selectVariant('cosmetic');
    const cosmetic = (await capture(request)).png;
    assert.equal(
      compareScreenshots(baseline, cosmetic).summary.status,
      'matched',
    );
    assert.equal(
      compareScreenshots(baseline, cosmetic, {
        pixelThreshold: 0,
        includeAntialiasing: true,
      }).summary.status,
      'changed',
    );
  },
);
