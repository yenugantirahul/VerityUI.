# Deltaframe

Deltaframe is a visual regression testing framework for analytics applications. It uses reproducible browser captures, immutable baseline evidence and explicit human review. See the [implementation progress](docs/implementation-progress.md) for the current delivery state.

## Local development

Install Node.js 24.20.0 and npm 11. Run the following from the repository root. Use `npm.cmd` in PowerShell if its script execution policy blocks `npm`.

```sh
npm ci
npx playwright install --no-shell chromium firefox webkit
npm run verify
npm start
```

Visit `http://127.0.0.1:4310/healthz` to check the compiled service. `npm run dev` starts it with file watching. The service listens on loopback and loads `.env` when present. Set `PORT` in that file or in the process environment.

Keep credentials in process environment or a scoped secret store. Keep local `.env` files and Playwright authentication state outside version control. CI uses the lockfile and the Node version in `.node-version`.

## Capture a sample analytics dashboard

```sh
npm run build
npm run capture:demo
```

The command starts a trusted fixture on an ephemeral loopback port, captures the page, closes the browser and server, and writes a PNG and metadata to `data/demo/`. Linux development machines may need `npx playwright install --with-deps --no-shell chromium firefox webkit`. Set `PLAYWRIGHT_SKIP_BROWSER_GC=1` during installation to retain browser binaries cached for other projects. Chromium uses its full browser in headless mode to better represent desktop rendering.

`src/capture/engine.ts` supports full pages and isolated components with exact browser profiles, a fixed wall clock, explicit readiness, font settling, screenshot masks, same-origin test sessions, and exact-path JSON fixtures. It blocks redirects and network requests outside the configured origin. The development engine is designed for trusted applications. Keep storage state out of tracked files.

The test worker image definition pins Node and retrieves the exact Playwright browser versions from the lockfile. With a local Docker engine, build it using `docker build -f Dockerfile.worker -t deltaframe-worker .` and run its fixture smoke command with `docker run --init --rm deltaframe-worker`.

## Compare a seeded visual change

```sh
npm run build
npm run compare:demo -- color
npm run benchmark:compare
```

Open `data/demo/color/comparison.json` for dimensions, changed-pixel counts, thresholds, and bounding boxes. The PNGs include the baseline, current image, changed pixels in magenta, a density heatmap, and a 50/50 overlay. Try `original`, `missing`, `shift`, `overflow`, `clipped`, `typography`, or `cosmetic` to change the seeded fixture.

`src/compare/compare.ts` exposes the same engine. `pixelThreshold` is the per-pixel perceptual tolerance between 0 and 1. A comparable image fails when both `maxChangedPixels` and `maxChangedRatio` are exceeded. A comparison with no baseline or different dimensions has its own status and skips pixel counts. For changed pixels within the configured area tolerance, the engine still returns their evidence.

## Baseline persistence

The baseline service in `src/persistence/baselines.ts` tracks candidates, approved history and audit events in PostgreSQL. It stores PNGs by SHA-256 in a private local directory. Initial candidate approval requires the reviewer or admin role. Promotion uses the active version seen by the capture and rollback uses the active version seen by the reviewer. When competing approvals target the same active version, one succeeds and the stale candidate remains reviewable.

The integration test starts a temporary real PostgreSQL instance, applies migrations, and exercises capture, approval, comparison, authorization and rollback. It does not require Docker. Run `node --test tests/baselines.test.ts` to focus on persistence.

For a persistent development database, copy `.env.example` to `.env`, set `DELTAFRAME_DB_PASSWORD` and `DATABASE_URL`, then use `docker compose up -d database`. `DATABASE_URL` can also point to a dedicated PostgreSQL 18 database running locally. Run `npm run build` and `npm run db:migrate` after the database accepts connections.

## Run the API and worker

With migrations applied, set a random `DELTAFRAME_API_TOKEN` in `.env`. Use at least 32 characters without whitespace. Run `npm start` in one terminal and `npm run worker` in another. Both processes use the same database and local `ARTIFACT_DIR`. The worker captures the bundled analytics fixture, compares approved baselines, and saves private PNG evidence. Use the [execution API](docs/api.md) for run submission and review.

## Engineering docs

- [Requirements and measurable objectives](docs/requirements.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Technology decisions and ADRs](docs/decisions.md)
- [Roadmap and phase gates](docs/roadmap.md)
- [Verification evidence](docs/test-results.md)
- [Risks](docs/risks.md)
