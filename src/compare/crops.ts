import { PNG } from 'pngjs';
import { readImage } from './images.ts';
import type { Region } from './regions.ts';

export function cropEvidence(
  baseline: Buffer,
  current: Buffer,
  regions: Region[],
) {
  if (!regions.length) return [];
  const images = [readImage(baseline), readImage(current)];
  return regions.slice(0, 4).map((region, index) => {
    const { width, height } = images[0]!;
    const cropWidth = Math.min(480, region.width + 32, width);
    const cropHeight = Math.min(360, region.height + 32, height);
    const left = Math.max(0, Math.min(region.x - 16, width - cropWidth));
    const top = Math.max(0, Math.min(region.y - 16, height - cropHeight));
    const crops = images.map((source) => {
      const target = new PNG({ width: cropWidth, height: cropHeight });
      for (let y = 0; y < cropHeight; y++) {
        const start = ((top + y) * source.width + left) * 4;
        source.data.copy(
          target.data,
          y * cropWidth * 4,
          start,
          start + cropWidth * 4,
        );
      }
      return PNG.sync.write(target);
    });
    return {
      id: `region-${index + 1}`,
      baseline: crops[0]!,
      current: crops[1]!,
    };
  });
}
