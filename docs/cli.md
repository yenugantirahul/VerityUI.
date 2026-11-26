# Developer CLI and CI

## Application verification

Build with `npm run build:server`, then run `npm run cli -- init` to generate `verityui.config.json`. The CLI looks for this file in the current directory and accepts an explicit `--config` path. Use `npm pack` to build a tarball after compiling the server. Install the tarball in your application as a development dependency to use the `verityui` executable and the TypeScript SDK exports from `@verityui/playwright`.

Pass `--config verityui.config.mts` to load a trusted TypeScript module with a default export from `defineConfig`. JSON is the default for CI configuration that only needs data.

```json
{
  "version": 2,
  "baseURL": "http://localhost:3000",
  "routes": [
    "/",
    { "path": "/checkout", "readySelector": "main", "masks": [".account-name"] }
  ],
  "viewports": [
    { "width": 390, "height": 844 },
    { "width": 1440, "height": 900 }
  ],
  "criticalRoutes": ["/checkout"],
  "capture": {
    "disableAnimations": true,
    "waitForFonts": true,
    "randomSeed": 42
  },
  "verification": {
    "mode": "review",
    "autoApprove": false,
    "intent": "intent.yaml"
  }
}
```

Use canonical route paths and an HTTP(S) origin. Capture blocks redirects and cross-origin requests. Serve assets like fonts on your application origin. A route accepts a CSS `selector` for component capture and CSS `masks` to redact elements from artefacts. A viewport can select `chromium`, `firefox` or `webkit` using `browser`. Install each browser you configure. Capture also supports `timeoutMs`, a fixed ISO `clock`, same-origin `jsonFixtures` keyed by request path, and `storageState` pointing to a Playwright state file relative to the config. Keep that state file in an ignored or ephemeral directory.

```sh
npm run cli -- capture --base-url http://localhost:3000 --output data/reference
npm run cli -- verify --base-url http://localhost:3001 --reference data/reference --output data/verification
npm run cli -- report --output data/verification
```

To compare previously captured states, run `capture` into a second directory and use `compare --reference data/reference --current data/candidate --output data/verification`. This command reads the captured artifacts without launching a browser. Use a fresh output directory on each invocation. Supply `--commit` or set `GITHUB_SHA` to record the source revision. Capture both versions with the same browser, viewport, renderer and capture settings so their identities match.

The bundle stores a PNG, metadata, a structural snapshot, an accessibility role summary, selected computed styles and a count of blocked requests. The report includes reference and candidate images, visual evidence, region crops and element property changes. DOM evidence omits rendered text, form values, arbitrary attributes and request URLs. Screenshots retain visible content outside the configured masks.

## Intent and vision triage

Mark components with `data-verity-component="CheckoutButton"` and use stable, unique `data-testid` values for the elements you want attributed across revisions. `data-verity-source="src/components/CheckoutButton.tsx:42"` records an application-supplied source location.

```yaml
intent:
  description: Update the checkout button
  allowedChanges:
    - component: CheckoutButton
      properties: [background-color, border-radius]
  protectedComponents: [Navbar, PaymentForm]
  protectedRoutes: [/settings]
```

A change within scope still requires review. A protected or critical route, protected component, incomplete structural evidence or unmatched visual change requires review. In strict mode, checks outside the declared scope fail. The CLI never promotes a persisted baseline.

Add `--ai` and set `VERITYUI_VISION_ENDPOINT`, `VERITYUI_VISION_MODEL` and `VERITYUI_VISION_KEY` in the process environment to request advisory classification from a compatible Chat Completions endpoint. The model must accept images and JSON Schema output. The CLI sends limited region crops and selected evidence for changed captures and validates the returned evidence IDs and source paths. A provider failure leaves the deterministic evidence and review decision available. [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

## Bundled fixture

The version 1 `deltaframe.config.json` and `run` alias still support the bundled analytics workflow and assertions when an app config is absent. Select this file with `--config deltaframe.config.json` if both configs exist.

```sh
npm run cli -- capture --output data/cli/reference
npm run cli -- run --reference data/cli/reference --output data/cli/unchanged
npm run cli -- run --reference data/cli/reference --output data/cli/recolor --variant color
```

A reference records the capture identity and SHA-256 for each PNG. `run` verifies both and emits `report.json` and evidence PNGs. `--config FILE` selects a version 1 config. `--commit` attaches a Git commit. When it is omitted in Actions, the CLI uses `GITHUB_SHA`.

| Exit code | Outcome                                                           |
| --------- | ----------------------------------------------------------------- |
| 0         | Reference created or all configured comparisons and checks passed |
| 1         | Visual change, changed dimensions or failed analytics check       |
| 2         | Compatible reference absent or a change needs review              |
| 3         | Inconclusive capture, configuration or artifact integrity error   |

## Review a persisted capture

The fixture workspace API is responsible for authorization and baseline history. Set `VERITYUI_API_TOKEN` in the CLI process environment and use IDs from the run result. The CLI uses the loopback API and protects the operation against replay by reusing the job's existing candidate.

```sh
npm run cli -- review --api http://127.0.0.1:4310 --project PROJECT_UUID --run RUN_UUID --job JOB_UUID --action approve
```

Use `--action reject` to reject. Review commands use the same role and stale-baseline checks as the dashboard. The offline `capture` command creates a local reference artifact. Database promotions are recorded only by the authenticated application review API.

## GitHub Actions

`visual.yml` builds both revisions of this repository, then uses the same CLI and Chromium version to capture the base fixture and verify the candidate. It uses read-only repository permissions. Open the workflow summary, then download `visual-report` and open `report.html` alongside its assets. Manual dispatch with `seeded_regression: true` exercises a failing comparison. To integrate your own app, replace both fixture startup steps with your app's build and start command. Use the reviewed configuration and verification tool from a trusted revision for enforcement. [GitHub Actions pull-request events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)

The first workflow uses the Actions job result and artifact rather than publishing a separate mutable check from the service. A GitHub App with scoped Checks write permission is the later integration for in-place updates after authorized review. Hosted verification requires an authorized repository and pull request. [GitHub Checks API](https://docs.github.com/en/rest/checks/runs)
