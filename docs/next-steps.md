# Next steps

## Phase 2 · Deterministic comparison

Implement `src/compare` using Pixelmatch and pngjs. Validate dimensions and decoding bounds, classify missing or incompatible images, and expose configurable color and area thresholds. Produce an exact changed-pixel mask, region bounds, a heatmap and an overlay. Exercise seeded defect variants with browser captures and provide a compiled evidence demo.

Run `npm run verify`, `npm run compare:demo` and the comparison benchmark. Require the seeded defects to exceed policy or report incompatible dimensions, and the identity and cosmetic cases to meet their declared policy. Record comparison time, process peak RSS, and limitations before Phase 3.
