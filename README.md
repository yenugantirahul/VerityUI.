# Deltaframe

Deltaframe is a visual regression testing framework for analytics applications. It uses reproducible browser captures, immutable baseline evidence and explicit human review. See the [implementation progress](docs/implementation-progress.md) for the current delivery state.

## Local development

Install Node.js 24.20.0 and npm 11. Run the following from the repository root. Use `npm.cmd` in PowerShell if its script execution policy blocks `npm`.

```sh
npm ci
npm run verify
npm start
```

Visit `http://127.0.0.1:4310/healthz` to check the compiled service. `npm run dev` starts it with file watching. The service listens on loopback. Set `PORT` in the process environment, or copy `.env.example` to `.env` and run `node --env-file=.env dist/server/main.js` after a build.

Keep credentials in process environment or a scoped secret store. Keep local `.env` files and Playwright authentication state outside version control. CI uses the lockfile and the Node version in `.node-version`.

## Engineering docs

- [Requirements and measurable objectives](docs/requirements.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Technology decisions and ADRs](docs/decisions.md)
- [Roadmap and phase gates](docs/roadmap.md)
- [Verification evidence](docs/test-results.md)
- [Risks](docs/risks.md)
