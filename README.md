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

Visit `http://127.0.0.1:4310/healthz` to check the compiled service. `npm run dev` starts it with file watching. The service listens on loopback. Set `PORT` in the process environment, or copy `.env.example` to `.env` and run `node --env-file=.env dist/server/main.js` after a build.

Keep credentials in process environment or a scoped secret store. Keep local `.env` files and Playwright authentication state outside version control. CI uses the lockfile and the Node version in `.node-version`.

## Capture a sample analytics dashboard

```sh
npm run build
npm run capture:demo
```

The command starts a trusted fixture on an ephemeral loopback port, captures the page, closes the browser and server, and writes a PNG and metadata to `data/demo/`. Linux development machines may need `npx playwright install --with-deps --no-shell chromium firefox webkit`. Set `PLAYWRIGHT_SKIP_BROWSER_GC=1` during installation to retain browser binaries cached for other projects. Chromium uses its full browser in headless mode to better represent desktop rendering.

`src/capture/engine.ts` supports full pages and isolated components with exact browser profiles, a fixed wall clock, explicit readiness, font settling, screenshot masks, same-origin test sessions, and exact-path JSON fixtures. It blocks redirects and network requests outside the configured origin. The development engine is designed for trusted applications. Keep storage state out of tracked files.

The test worker image definition pins Node and retrieves the exact Playwright browser versions from the lockfile. With a local Docker engine, build it using `docker build -f Dockerfile.worker -t deltaframe-worker .` and run its fixture smoke command with `docker run --init --rm deltaframe-worker`.

## Engineering docs

- [Requirements and measurable objectives](docs/requirements.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Technology decisions and ADRs](docs/decisions.md)
- [Roadmap and phase gates](docs/roadmap.md)
- [Verification evidence](docs/test-results.md)
- [Risks](docs/risks.md)
