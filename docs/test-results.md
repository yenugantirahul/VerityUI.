# Verification evidence

| Assessment command                     | Actual result                                              |
| -------------------------------------- | ---------------------------------------------------------- |
| `node --version` / `npm.cmd --version` | v24.20.0 / 11.19.0                                         |
| `git --version`                        | 2.56.0.windows.2                                           |
| `docker --version` / `docker info`     | 29.8.2 CLI. The local Linux engine socket was unavailable. |

## Phase 0 · Local toolchain

| Command                                  | Expected                                   | Actual                                                       |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `npm ci`                                 | Clean locked install                       | Exit 0, 152 packages installed, audit reported zero findings |
| `npm run verify`                         | Formatting, lint, type-check, build, tests | Exit 0, all checks passed, 2 tests passed                    |
| `npm start` + GET `/healthz`             | Compiled service responds                  | HTTP 200 `{"status":"ok"}` at port 4310                      |
| `PORT=4311 npm run dev` + GET `/healthz` | Source watch service responds              | HTTP 200 `{"status":"ok"}` at port 4311                      |

The first watch-server launch overlapped with `npm start` and reported `EADDRINUSE`. Running the watch server on a separate configured port passed. GitHub workflow commands were verified locally. Hosted Actions execution requires a remote repository.

Proposed targets and acceptance criteria are listed in `requirements.md` and `roadmap.md`.

## Phase 1 · Deterministic capture

| Command                                                    | Expected                                                                                       | Observed                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused Chromium tests in `tests/capture.test.ts`          | Repeatability, masks, mobile and HiDPI dimensions, sessions, mocks, typed failures and cleanup | 6 passed, 0 failed in 21.1 seconds. Desktop output matched byte for byte across 10 fresh browser instances.                                                                             |
| `npm run build` then `npm run capture:demo`                | Compiled fixture writes PNG and metadata                                                       | Exit 0. Inspected a 1200 × 807 image of the KPI cards, chart and table, 32,703 bytes. Chromium 156.0.8078.4 captured it in 1,059 ms.                                                    |
| `docker buildx imagetools inspect node:24.20.0-bookworm`   | Resolve pinned worker base manifest                                                            | Resolved the multi-platform digest tracked by `Dockerfile.worker`.                                                                                                                      |
| `docker build -f Dockerfile.worker -t deltaframe-worker .` | Build worker image                                                                             | Local Linux engine socket unavailable. Launching Docker Desktop through the shell was rejected by the execution policy. Native browser verification is independent of the worker image. |

The source test runner rejected a TypeScript constructor parameter property. The class now declares its fields explicitly and TypeScript enforces erasable syntax in development and tests. The demo revealed that full-page height can exceed viewport height because of scrollable content. The test now verifies full-page and viewport dimensions independently.

An initial Firefox repeat differed by three compressed bytes in length. The engine now waits for two animation frames after page readiness and font loading so the browser can paint settled content. The full `npm run verify` exited 0 with 10 passing tests in 44.1 seconds. Chromium, Firefox and WebKit each produced 10 byte-identical desktop captures. The lockfile audit found zero reported vulnerabilities.

## Phase 2 · Deterministic comparison

| Command                                                  | Expected                                                         | Observed                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                                         | Static checks, browser matrix, comparison unit and fixture tests | Exit 0, 14 passed and 0 failed in 45.4 seconds. Changed color, missing content, shifted content, clipping and typography yielded localized differences. Overflow produced incompatible dimensions. Identical and cosmetic inputs passed default policy and strict comparison detected the cosmetic tint. |
| `npm run benchmark:compare`                              | Actual browser screenshots and measured processing               | Exit 0. 30 comparisons of 1200 × 807 PNGs, including decoding and encoding all three evidence images. Median 343 ms, p95 401 ms, Node process peak RSS 366 MiB. Browser child memory is outside that figure.                                                                                             |
| Inspect `data/demo/color/diff.png` and `comparison.json` | Localize seeded recolor                                          | 108,847 pixels (11.240%), bounded to the chart bars at x=67, y=351, width=1066, height=164.                                                                                                                                                                                                              |

The first typography fixture changed both font metrics and the page height. The fixture now preserves line height while changing size and weight, so it exercises same-dimension typography differences. Malformed PNGs, interlace, excessive dimensions and invalid thresholds are covered by targeted tests. Existing Playwright browser cache entries removed during dependency installation were restored.

### Geometry and structural evaluation

A direct DOM inspection of the eight Chromium fixture variants measured an 18 px chart shift, a 72 px plot overhang beyond the chart container, a hidden sessions KPI, a changed clip path, and a reduced KPI font size from 25 to 20 px. These signals classified five of six seeded defects. Color-only and cosmetic tint changes had identical geometry to the reference. The screenshot engine detected all six seeded defects using pixel and dimension checks under the default policy. Use DOM checks in the analytics phase for precise explanations and explicit content assertions. Pixel evidence stays the initial review source.

Known limits include platform-dependent glyph rasterization, merging near changes into the same 16 px tile group, and differences below the chosen thresholds. Run one comparison per initial worker and benchmark maximum dimensions before raising concurrency. A sample benchmark with one workstation and one viewport gives no staging SLO evidence.
