import { PNG } from 'pngjs';
import { maxCapturePixels } from '../capture/policy.ts';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxPngBytes = 60 * 1024 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageError';
  }
}

export function readImage(png: Buffer) {
  if (
    png.length < 33 ||
    png.length > maxPngBytes ||
    !png.subarray(0, 8).equals(pngSignature) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new InvalidImageError('Expected a bounded PNG with a valid header.');
  }
  if (png[24] !== 8 || png[28] !== 0) {
    throw new InvalidImageError(
      'Expected an 8-bit, non-interlaced screenshot.',
    );
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > maxCapturePixels) {
    throw new InvalidImageError(
      'PNG dimensions exceed the comparison pixel budget.',
    );
  }
  try {
    const image = PNG.sync.read(png, { checkCRC: true });
    if (
      image.width !== width ||
      image.height !== height ||
      image.data.length !== width * height * 4
    ) {
      throw new Error('Unexpected decoded size');
    }
    return image;
  } catch {
    throw new InvalidImageError('PNG could not be decoded.');
  }
}
