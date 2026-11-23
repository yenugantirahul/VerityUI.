# Next steps

## Phase 1 · Deterministic capture

Implement `src/capture` and an analytics fixture in `src/fixture`. Add exact browser dependencies, rendering profiles, fixed clock, device scale, readiness and font checks, authenticated storage state, exact-path JSON responses, masks, capture metadata, stable errors and resource cleanup. Add a compiled smoke command and documented image profile. Use only the operator-controlled fixture origin. Browser rendering, redirects, runaway page area and context leaks are the main risks.

Run `npm run verify` with the pinned browser builds installed, plus a compiled fixture capture. Require byte repeatability, viewport and scale correctness, stable masked output, working authentication and mocks, closed contexts, and classified failures before Phase 2.
