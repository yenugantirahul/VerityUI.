export { defineConfig, type ApplicationConfig } from '../cli/config.ts';
export { capture, type CaptureResult } from '../capture/engine.ts';
export { desktopProfile, type CaptureRequest } from '../capture/policy.ts';
export {
  compareScreenshots,
  type ComparisonResult,
} from '../compare/compare.ts';
export {
  compareStructure,
  type StructuralEvidence,
} from '../compare/structure.ts';
