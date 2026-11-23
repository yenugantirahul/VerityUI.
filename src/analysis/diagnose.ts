import type { ComparisonResult } from '../compare/compare.ts';
import { readImage } from '../compare/images.ts';

export const analysisVersion = 'pixel-evidence-2';
export type Classification =
  | 'identical'
  | 'minor'
  | 'color'
  | 'removed'
  | 'layout'
  | 'clipped'
  | 'text'
  | 'unclassified';
export type Analysis =
  | { state: 'not_applicable' | 'unavailable'; version: string }
  | {
      state: 'available';
      version: string;
      classification: Classification;
      severity: 'none' | 'low' | 'medium' | 'high';
      confidence: number;
      explanation: string;
      suggestion: string;
      regionIndexes: number[];
      evidence: {
        dimensionsChanged: boolean;
        changedPixels: number;
        changedRatio: number;
        inspectedPixels: number;
        pairedColor: number;
        cleared: number;
        added: number;
        clearedColor: number;
      };
    };

const descriptions: Record<Classification, [string, string]> = {
  identical: [
    'The two captures contain identical image bytes.',
    'Keep the current approved baseline.',
  ],
  minor: [
    'The screenshot differs within the configured tolerance.',
    'Review the two renders if the affected component has stricter visual requirements.',
  ],
  color: [
    'Most changed pixels were colored in both captures, suggesting a palette change.',
    'Inspect the paint colors, chart series palette, and theme configuration.',
  ],
  removed: [
    'The changed region primarily became background-colored, suggesting missing content.',
    'Inspect the component visibility, empty state, and fixture data.',
  ],
  layout: [
    'The changed pixels suggest a size or position change in the rendered layout.',
    'Inspect container dimensions, spacing, and overflow at this viewport.',
  ],
  clipped: [
    'A broad band of previously colored pixels became light background, suggesting clipping.',
    'Inspect the plot container, clip path, and available height.',
  ],
  text: [
    'Changes are concentrated in short, low-area regions with both dark-pixel gains and losses.',
    'Inspect the visible values, formatting, font size, weight, and font loading.',
  ],
  unclassified: [
    'The pixel evidence shows a change with an uncertain cause.',
    'Review the diff and inspect the largest changed regions.',
  ],
};

function sampleVisualChanges(
  baselinePng: Buffer,
  currentPng: Buffer,
  difference: Buffer,
) {
  const baseline = readImage(baselinePng).data;
  const current = readImage(currentPng).data;
  let inspectedPixels = 0;
  let pairedColor = 0;
  let cleared = 0;
  let added = 0;
  let clearedColor = 0;
  for (let offset = 0; offset < difference.length; offset += 4) {
    if (!difference[offset + 3]) continue;
    inspectedPixels++;
    const before = [
      baseline[offset]!,
      baseline[offset + 1]!,
      baseline[offset + 2]!,
    ];
    const after = [
      current[offset]!,
      current[offset + 1]!,
      current[offset + 2]!,
    ];
    const beforeColor = Math.max(...before) - Math.min(...before) >= 45;
    const afterColor = Math.max(...after) - Math.min(...after) >= 45;
    const beforeLight = Math.min(...before) >= 195;
    const afterLight = Math.min(...after) >= 195;
    if (beforeColor && afterColor) pairedColor++;
    if (!beforeLight && afterLight) cleared++;
    if (beforeLight && !afterLight) added++;
    if (beforeColor && afterLight) clearedColor++;
  }
  const total = Math.max(1, inspectedPixels);
  return {
    inspectedPixels,
    pairedColor: pairedColor / total,
    cleared: cleared / total,
    added: added / total,
    clearedColor: clearedColor / total,
  };
}

export function diagnose(
  baseline: Buffer | undefined,
  current: Buffer,
  comparison: ComparisonResult,
): Analysis {
  if (!baseline || comparison.summary.status === 'missing')
    return { state: 'not_applicable', version: analysisVersion };
  const { summary, changeMask } = comparison;
  const dimensionsChanged = summary.status === 'incompatible';
  const changedPixels = summary.changedPixels ?? 0;
  const changedRatio = summary.changedRatio ?? 0;
  const features = changeMask
    ? sampleVisualChanges(baseline, current, changeMask)
    : {
        inspectedPixels: 0,
        pairedColor: 0,
        cleared: 0,
        added: 0,
        clearedColor: 0,
      };
  const region = summary.regions[0];
  let classification: Classification = 'unclassified';
  let confidence = 0.4;
  if (summary.status === 'matched') {
    classification = baseline.equals(current) ? 'identical' : 'minor';
    confidence = 1;
  } else if (dimensionsChanged) {
    classification = 'layout';
    confidence = 1;
  } else if (features.pairedColor >= 0.72) {
    classification = 'color';
    confidence = features.pairedColor;
  } else if (
    features.clearedColor > 0.64 &&
    region &&
    region.width > summary.current.width * 0.2 &&
    region.width >= region.height * 2.5
  ) {
    classification = 'clipped';
    confidence = features.clearedColor;
  } else if (features.cleared >= 0.79 && features.added <= 0.1) {
    classification = 'removed';
    confidence = features.cleared;
  } else if (
    changedRatio < 0.012 &&
    region &&
    region.height <= 46 &&
    features.added > 0.04
  ) {
    classification = 'text';
    confidence = 0.65;
  } else if (features.cleared >= 0.1 && features.added >= 0.1) {
    classification = 'layout';
    confidence = 0.7;
  }
  const [explanation, suggestion] = descriptions[classification];
  const severity =
    summary.status === 'matched'
      ? 'none'
      : dimensionsChanged || changedRatio >= 0.1
        ? 'high'
        : changedRatio >= 0.005
          ? 'medium'
          : 'low';
  return {
    state: 'available',
    version: analysisVersion,
    classification,
    severity,
    confidence,
    explanation,
    suggestion,
    regionIndexes: summary.regions.slice(0, 3).map((_, index) => index),
    evidence: { dimensionsChanged, changedPixels, changedRatio, ...features },
  };
}

export function diagnoseSafely(
  baseline: Buffer | undefined,
  current: Buffer,
  comparison: ComparisonResult,
  classify: typeof diagnose = diagnose,
): Analysis {
  try {
    return classify(baseline, current, comparison);
  } catch {
    return { state: 'unavailable', version: analysisVersion };
  }
}
