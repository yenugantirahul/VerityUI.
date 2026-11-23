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

## Phase 3 · Baseline persistence

| Command                               | Expected                                    | Observed                                                                                             |
| ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `node --test tests/baselines.test.ts` | Real database and write-once artifact tests | 2 passed. PostgreSQL 18.7 x86-64 Windows verified.                                                   |
| `npm run verify`                      | Formatting, lint, types, build, full suite  | Exit 0. 16 passed and 0 failed in 46.5 seconds.                                                      |
| `docker compose config --quiet`       | Validate PostgreSQL service definition      | Exit 0. Registry resolved the PostgreSQL 18.7 image digest. Engine unavailable for container launch. |
| `npm audit --audit-level=high`        | Dependency audit                            | Exit 0, zero findings reported.                                                                      |

The baseline test uses two real browser captures and real database locks. One of two competing promotions succeeded. The losing candidate remained reviewable, rejection preserved history, and rollback moved the pointer back without mutating either artifact. Access was denied for a viewer attempting approval and a second organization using the same project identifier. A filesystem write obstruction left no candidate and retry succeeded after clearing it. Independently, write-once artifact tests detected corruption without replacing the original digest key.

The direct Windows postmaster rejected the elevated shell. The harness now uses PostgreSQL's `pg_ctl` on Windows, which starts the server with a restricted token. The test verifies the real server version and stops the temporary cluster. [PostgreSQL Windows startup code](https://github.com/postgres/postgres/blob/master/src/bin/pg_ctl/pg_ctl.c)

## Phase 4 · Execution API and worker

`npm run verify` exited 0 with formatting, lint, type checking, build, and 17 passing tests in 84.8 seconds. The pipeline test made real HTTP requests and used PostgreSQL 18, Chromium and the local artifact store. A concurrent duplicate request produced one run. An initial result became an approved baseline, then a changed run exposed its private diff. The test stopped a separate worker process after a durable claim and confirmed that a replacement could reclaim its expired lease and fence old writes.

The test also stopped PostgreSQL, observed a 503 from the API and a queue claim failure, restarted the same data directory, and resumed work. A transient write failure requeued the job. Cancelling an active job prevented its late completion. A run with two checkpoints stored a successful match alongside a terminal timeout after three attempts. The API routes and persistence contracts are documented in `api.md`.

## Phase 5 · Review dashboard

`npm run verify` passed formatting, lint, server and web type-checking, both production builds and 18 tests in 86.8 seconds. Vite produced a 73.0 KiB gzipped JavaScript bundle. The real Chromium end-to-end test covered invalid and valid login, HttpOnly and SameSite cookie flags, authorized workspace selection, viewer restrictions, rejection of an unrelated workspace and cross-origin submission, project and suite creation, run execution, real PNG evidence, keyboard slider operation, baseline approval, rejection, history after reload, sign-out and forbidden private evidence. The viewport fit the page at 390 CSS pixels.

The verified dashboard screenshot is generated at `data/demo/workspace.png`. Workspace sessions live in one local API process. Persisted projects, runs, captures and reviews survive session expiration. The hosted authentication and worker isolation gates remain separate.

The standalone demo's compiled dashboard and health endpoint returned HTTP 200. Port 4310 was occupied by another listener, so the demo now picks an available port by default and honors `PORT` when set. An interrupted wrapper process left a temporary PostgreSQL server, which was shut down using `pg_ctl`. An execution-policy rejection prevented removing that stopped temporary directory. A subsequent demonstration used the Enter shutdown path and exited 0.

## Phase 6 · Rule-based evidence analysis

`npm run evaluate:analysis` examined 30 actual Chromium capture pairs, with 20 viewport-held-out pairs at widths 430 and 1600. The data includes a numeric KPI regression, a removed KPI, a clipped chart, chart overflow, positional shifts, typography, color, cosmetic noise, and masked dynamic content. All viewports share the same synthetic application and defect families.

| Metric                          | Observed                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Authoritative pixel detection   | 14 TP, 6 TN, zero FP and FN. Precision, recall and F1 were 1.0 for these cases.                                                |
| Diagnostic macro F1             | 1.0 across seven labels. Pixel-only output mapped to identity or a generic change for comparison and scored 0.114.             |
| Critical findings and grounding | No critical case suppressed. All 20 automated grounding checks matched comparison counts and valid region references.          |
| Localization                    | 98.7% mean containment of the primary reported region inside the labeled widget over 12 localized cases.                       |
| Resources                       | Incremental analysis p95 83 ms. Evaluation Node peak RSS 263 MiB including captures and comparison. No remote inference calls. |

The first rule set mislabeled clipping as removal. The second version improved clipping on the training viewport and was evaluated against two fresh widths. The checks establish numerical grounding on synthetic fixtures. Calibration and generalization to unrelated dashboards require an independently labeled dataset. Keep the rule engine as advisory and defer learned inference pending evidence of added value.

`npm run verify` passed 18 tests in 87.7 seconds. Integration also verified persisted versioned feedback, rejection of feedback targeting a missing analysis version, and preservation of comparison and artifacts when the classifier throws.
