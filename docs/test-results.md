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
