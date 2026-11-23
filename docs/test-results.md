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
