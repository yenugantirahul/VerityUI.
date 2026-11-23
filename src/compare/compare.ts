import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readImage, type ImageSize } from './images.ts';
import { locateRegions, tileSize, type Region } from './regions.ts';

export interface ComparisonPolicy {
  pixelThreshold: number;
  maxChangedPixels: number;
  maxChangedRatio: number;
  includeAntialiasing: boolean;
}

export interface ComparisonSummary {
  status: 'matched' | 'changed' | 'missing' | 'incompatible';
  message: string;
  policy: ComparisonPolicy;
  current: ImageSize;
  baseline?: ImageSize;
  changedPixels?: number;
  changedRatio?: number;
  regions: Region[];
  omittedRegions: number;
}

export interface ComparisonResult {
  summary: ComparisonSummary;
  artifacts?: Record<'diff' | 'heatmap' | 'overlay', Buffer>;
}

export const defaultComparisonPolicy: Readonly<ComparisonPolicy> =
  Object.freeze({
    pixelThreshold: 0.1,
    maxChangedPixels: 0,
    maxChangedRatio: 0,
    includeAntialiasing: false,
  });

function settings(overrides: Partial<ComparisonPolicy>): ComparisonPolicy {
  const policy = { ...defaultComparisonPolicy, ...overrides };
  if (
    ![policy.pixelThreshold, policy.maxChangedRatio].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) ||
    !Number.isSafeInteger(policy.maxChangedPixels) ||
    policy.maxChangedPixels < 0 ||
    typeof policy.includeAntialiasing !== 'boolean'
  ) {
    throw new RangeError('Comparison policy contains an invalid threshold.');
  }
  return policy;
}

function paintEvidence(
  baseline: ReturnType<typeof readImage>,
  current: ReturnType<typeof readImage>,
  mask: Buffer,
  locations: ReturnType<typeof locateRegions>,
) {
  const { width, height } = current;
  const { columns, tiles } = locations;
  const image = new PNG({ width, height });
  const output = image.data;
  const pixel = (source: Buffer, offset: number, channel: number) => {
    const opacity = source[offset + 3]! / 255;
    return source[offset + channel]! * opacity + 255 * (1 - opacity);
  };

  function encode(mode: 'diff' | 'heatmap' | 'overlay') {
    for (let y = 0; y < height; y++) {
      const tileRow = Math.floor(y / tileSize) * columns;
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        output[offset + 3] = 255;
        if (mode === 'overlay') {
          for (let channel = 0; channel < 3; channel++) {
            output[offset + channel] = Math.round(
              (pixel(baseline.data, offset, channel) +
                pixel(current.data, offset, channel)) /
                2,
            );
          }
          continue;
        }
        const gray =
          pixel(current.data, offset, 0) * 0.21 +
          pixel(current.data, offset, 1) * 0.72 +
          pixel(current.data, offset, 2) * 0.07;
        if (mode === 'diff') {
          const changed = mask[offset + 3] !== 0;
          const shade = Math.round(190 + 0.23 * gray);
          output[offset] = changed ? 222 : shade;
          output[offset + 1] = changed ? 22 : shade;
          output[offset + 2] = changed ? 99 : shade;
        } else {
          const count = tiles[tileRow + Math.floor(x / tileSize)]!;
          const intensity = count
            ? Math.min(1, 0.28 + count / (tileSize * tileSize))
            : 0;
          const shade = gray * 0.29;
          output[offset] = Math.round(
            shade * (1 - intensity) + 255 * intensity,
          );
          output[offset + 1] = Math.round(
            shade * (1 - intensity) + 86 * intensity,
          );
          output[offset + 2] = Math.round(
            shade * (1 - intensity) + 24 * intensity,
          );
        }
      }
    }
    return PNG.sync.write(image);
  }
  return {
    diff: encode('diff'),
    heatmap: encode('heatmap'),
    overlay: encode('overlay'),
  };
}

export function compareScreenshots(
  baselinePng: Buffer | undefined,
  currentPng: Buffer,
  overrides: Partial<ComparisonPolicy> = {},
): ComparisonResult {
  const policy = settings(overrides);
  const current = readImage(currentPng);
  const baseline = baselinePng?.equals(currentPng)
    ? current
    : baselinePng && readImage(baselinePng);
  const dimensions = ({ width, height }: ImageSize) => ({ width, height });
  const summary = {
    policy,
    current: dimensions(current),
    baseline: baseline && dimensions(baseline),
    regions: [],
    omittedRegions: 0,
  };
  if (!baseline) {
    return {
      summary: {
        ...summary,
        status: 'missing',
        message: 'This capture has no approved baseline.',
      },
    };
  }
  const { width, height } = current;
  if (baseline.width !== width || baseline.height !== height) {
    return {
      summary: {
        ...summary,
        status: 'incompatible',
        message: `Capture dimensions changed from ${baseline.width} × ${baseline.height} to ${width} × ${height}.`,
      },
    };
  }
  const mask = Buffer.alloc(width * height * 4);
  const changedPixels =
    baseline === current
      ? 0
      : pixelmatch(baseline.data, current.data, mask, width, height, {
          threshold: policy.pixelThreshold,
          includeAA: policy.includeAntialiasing,
          diffMask: true,
        });
  const changedRatio = changedPixels / (width * height);
  const exceedsPolicy =
    changedPixels > policy.maxChangedPixels &&
    changedRatio > policy.maxChangedRatio;
  const result: ComparisonSummary = {
    ...summary,
    status: exceedsPolicy ? 'changed' : 'matched',
    message:
      changedPixels === 0
        ? 'The images match at the configured pixel threshold.'
        : `${changedPixels} pixels differ (${(changedRatio * 100).toFixed(3)}%). The difference ${exceedsPolicy ? 'exceeds' : 'meets'} policy limits.`,
    changedPixels,
    changedRatio,
  };
  if (!changedPixels) return { summary: result };
  const locations = locateRegions(mask, width, height);
  result.regions = locations.regions;
  result.omittedRegions = locations.omittedRegions;
  return {
    summary: result,
    artifacts: paintEvidence(baseline, current, mask, locations),
  };
}
