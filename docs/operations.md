# Operating VerityUI

## Run the API and worker

Provision PostgreSQL and a private persistent artifact directory. The API and worker use the same database and artifact directory. Run the migration command once per release before starting the new processes.

```sh
npm ci
npm run build
npm run db:migrate
npm start
```

Start `npm run worker` in a separate process with the same `DATABASE_URL` and `ARTIFACT_DIR`. Install pinned Chromium with `npx playwright install --no-shell chromium` if you run the bundled browser fixture. Upload processing uses the PNG and DOM evidence captured in customer CI.

Set a unique `VERITYUI_API_TOKEN` with at least 32 random characters. The app binds to loopback. To expose the pilot to CI, run a same-host HTTPS reverse proxy and set `VERITYUI_PUBLIC_ORIGIN` to its external origin. This origin controls browser mutation validation and secure cookies. Allow uploads up to 8 MiB through the proxy and limit request rates there. Back up PostgreSQL and private artifacts together. Revoke an expired or exposed credential and replace the CI secret.

## Submit a verification run

Install the local VerityUI package and create an application capture config with the [CLI setup guide](cli.md).

In the project's **CI settings**, create a credential and set its baseline branch to the protected branch used for releases. Store its value as `VERITYUI_CI_TOKEN` and set `VERITYUI_API_URL` to the HTTPS origin. The credential expires after 90 days and can be revoked immediately. It permits submission and status polling for that project. The interactive workspace retains baseline review permissions.

```sh
npx verityui capture --output captures
npx verityui upload --input captures --wait
```

GitHub Actions supplies the branch and commit. On other runners, pass `--commit SHA` when capturing and `--branch NAME` when uploading. Approve the first capture from the configured baseline branch to establish the reference. Future runs compare against that reference. The worker preserves the baseline version it compared so that approvals continue to use the existing transactional stale-review check.

Branch and commit values come from the credential holder. Keep the secret in a trusted workflow and use a protected GitHub environment scoped to reviewed refs. Use the offline `verify` command on untrusted pull requests. [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

`upload` returns a shareable workspace URL. Replaying the same payload and idempotency key returns the existing run. `--wait` exits 0 for a passing comparison, 2 when review is required, or 3 for an inconclusive comparison, timeout or API error. The wait window is two minutes. Each upload has up to 20 checkpoints and an 8 MiB request limit. Each screenshot has a 3 MiB and six-million-pixel limit, and each DOM snapshot has a 512 KiB limit. The API bounds concurrent uploads and project activity. A corrupt comparison fails its checkpoint without advancing a baseline.

## Health and quality signals

| Signal          | Meaning                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`      | The API process responds                                                                                                  |
| `/readyz`       | The API sees the CI migration and can access the artifact directory                                                       |
| Dashboard runs  | Number of runs started in the past seven days                                                                             |
| Needs review    | Completed checkpoints that differ, need a baseline, or have incomplete structural evidence without a recorded disposition |
| Completion rate | Compared checkpoints divided by compared plus failed checkpoints. Pending and cancelled work is excluded                  |
| P95 turnaround  | 95th percentile from submission to comparison. Queue P95 measures the wait until a worker first claims the checkpoint     |

Set an independent `VERITYUI_METRICS_TOKEN` and use it as a bearer credential to scrape `/metrics`. The endpoint exports process-local HTTP request counts by status class and a request latency histogram. It omits workspace identifiers. Track 5xx ratio, HTTP latency, comparison completion and turnaround separately so infrastructure failures remain visible even when no visual regression is present.

Run `npm run benchmark:ci` to measure a controlled local workload with two upload producers, one worker, and 16 PNG comparisons across clean and changed captures. It stops if a verdict differs from the seeded expectation and prints upload and queue latency measurements.

## Pilot deployment boundaries

The pilot uses a loopback API, one shared operator login, a PostgreSQL-backed work queue and filesystem artifacts shared by the API and worker. Public multi-user operation still requires managed identity, independent cloud artifact storage and retention, and production monitoring and recovery exercises. GitHub App identity or attestations are required to independently verify repository and commit provenance.
