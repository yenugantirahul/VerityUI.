# Architecture

The control plane is a modular monolith. A separate worker process owns capture and comparison. A disposable browser profile exists per job. Initial local execution is limited to a trusted fixture and development operator. The hosted topology extends the same job and storage contracts.

## Components and deployment

```mermaid
flowchart LR
  Dev[Developer CLI or browser] -->|HTTPS| API[Fastify control plane]
  CI[GitHub Actions] --> API
  UI[React static review UI] --> API
  API --> Project[Projects and suite revisions]
  API --> Review[Review and tenant authorization]
  API --> PG[(PostgreSQL metadata and queue)]
  Project --> PG
  Review --> PG
  W[Worker processes] -->|Claim and commit| PG
  W --> B[Disposable browser runtime]
  W --> Diff[Deterministic comparison]
  W -.-> AI[Optional evidence analysis]
  Diff --> Blob[(Private PNG artifacts)]
  API -->|Authorized read| Blob
```

```mermaid
flowchart TB
  subgraph Ingress[Public ingress]
    UI[Browser or CI] --> EDGE[TLS and rate limit]
  end
  subgraph Control[Private control network]
    EDGE --> API[API and static dashboard]
    API --> DB[(Postgres and backups)]
    API --> OBJ[(Private bucket)]
    WORKER[Worker controller] --> DB
    WORKER --> OBJ
    API --> OTLP[Telemetry collector]
    WORKER --> OTLP
  end
  subgraph Isolated[Separate browser execution boundary]
    WORKER --> B[Sandboxed browser with bounded resources]
    B --> PROXY[Restricted egress broker]
    PROXY --> TARGET[Explicitly authorized application]
  end
```

## Execution and data flow

```mermaid
sequenceDiagram
    actor Operator
    participant API
    participant DB as Postgres
    participant Worker
    participant Browser
    participant Objects as Artifact store
    Operator->>API: Create run with suite revision and idempotency key
    API->>DB: Commit run plus jobs atomically
    API-->>Operator: 202 and run ID
    Worker->>DB: Claim job with a fenced lease
    Worker->>Browser: Open isolated context and capture checkpoint
    Browser-->>Worker: PNG and capture metadata
    Worker->>DB: Read active baseline for the captured profile
    Worker->>Objects: Verify baseline and write immutable evidence
    Worker->>DB: Commit leased result and artifact references
    Operator->>API: Read result and compare images
    Operator->>API: Approve candidate with expected active revision
    API->>DB: Lock pointer and append version and audit event
```

```mermaid
flowchart LR
  Config[Immutable suite revision] --> Matrix[Checkpoint and rendering matrix]
  Matrix --> Capture[PNG and metadata]
  Capture --> Identity[Baseline identity and active revision]
  Active[Approved PNG and digest] --> Compare[Compare PNGs]
  Identity --> Compare
  Capture --> Compare
  Compare --> Evidence[Statuses, changed regions and artifact references]
  Compare -.-> Findings[Optional explanatory findings]
  Evidence --> Review[Review and CI independently evaluate evidence]
  Findings --> Review
```

## Entity relationships

```mermaid
erDiagram
  ORGANIZATION ||--o{ MEMBERSHIP : has
  PRINCIPAL ||--o{ MEMBERSHIP : holds
  ORGANIZATION ||--o{ PROJECT : owns
  PROJECT ||--o{ SUITE_REVISION : configures
  SUITE_REVISION ||--o{ RUN : drives
  RUN ||--o{ JOB : schedules
  JOB ||--o| RESULT : yields
  PROJECT ||--o{ BASELINE_KEY : scopes
  BASELINE_KEY ||--o{ BASELINE_VERSION : versions
  BASELINE_KEY ||--o| BASELINE_VERSION : points_to_active
  RESULT ||--o{ ARTIFACT_REFERENCE : attaches
  RESULT ||--o{ REVIEW_EVENT : receives
  RESULT ||--o{ FINDING : annotates
  BASELINE_VERSION ||--|| ARTIFACT_REFERENCE : pins
```

PostgreSQL owns tenants, configurations, identities, run transitions, reviewer decisions and artifact metadata. Immutable objects own PNG bytes and are addressed by SHA-256 under tenant scope. Queue state cannot alter comparison state. Baseline keys include project-scoped stable checkpoint ID, environment, canonical capture options and fixture revision, viewport, scale, locale, timezone, browser build, and rendering image. Compare against a baseline snapshot and reference that version in the result for reproducibility. Review uses the observed active version as the expected value for compare-and-swap and appends an audit event. Rollback repoints to a historical approved version while recording a new review action.

## State transitions

```mermaid
stateDiagram-v2
  state Execution {
    [*] --> queued
    queued --> running
    queued --> cancelled
    running --> queued: retry or lease expiry
    running --> completed
    running --> failed
    running --> cancelled
  }
  state Comparison {
    [*] --> pending
    pending --> matched
    pending --> changed
    pending --> missing
    pending --> incompatible
  }
  state Review {
    [*] --> undecided
    undecided --> approved
    undecided --> rejected
  }
```

## Failure handling

- Idempotency keys are scoped to project and actor with a request digest. Reuse with different input returns conflict. A DB transaction covers run and queued work creation. Workers lease jobs with a fencing value and reject stale completions.
- Transient browser and store failures retry after bounded backoff. Invalid configurations and permanent capture errors terminate the attempt. A cancel request prevents new claims and blocks committing normal results once the worker acknowledges cancellation.
- Artifact writes precede metadata commits. A partial upload or lost lease can leave orphan bytes. Retry by digest and sweep unreferenced objects only after the maximum attempt window and backup-safe grace period.
- On AI outage, record analysis availability and keep deterministic evidence readable. On storage outage, emit an execution error with no comparison claim. Run state aggregates all jobs including partial failures.

## Trust boundaries

```mermaid
flowchart LR
  Client[Human or CI identity] -->|Session or scoped token| API[Trusted control plane]
  API -->|Tenant-scoped rows| PG[(Private DB)]
  API -->|Authorize artifact reference| Store[(Private storage)]
  Worker[Trusted worker controller] -->|Scoped attempt token| Runtime[Untrusted page runtime]
  Runtime -->|Network policy and vetted DNS| Egress[Default deny egress broker]
  Egress --> App[Approved target]
  Runtime -->|Bounded screenshot bytes| Worker
  Worker -->|Validated PNG and digest| Store
  Worker -.->|Tenant opt-in and scoped evidence| Model[Optional model runtime]
```

Production egress validates HTTPS destinations on redirects, resolves and verifies IPs at connection time, and blocks internal and cloud metadata networks. The browser cannot reach the control plane, object store, or database. Use disposable sandboxed processes with process, memory, time and file limits. Browser context routing is development defense in depth. OIDC identity maps to tenant-scoped membership. Require review permissions, private artifacts, redacted logs, and network isolation before connecting external targets.
