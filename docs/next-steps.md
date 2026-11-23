# Next steps

## Phase 4 · Asynchronous run execution

Add persisted suite revisions, API contracts and a PostgreSQL job queue. Create runs and work in one transaction. Use bounded attempts, leased claims, fenced completion, cancellation, and private stored evidence. Scope all control-plane requests to an authenticated local operator. Keep the worker limited to operator-controlled analytics fixtures until the network-isolation gate.

Verify asynchronous submission, duplicate requests, concurrent workers, interrupted attempts, transient storage errors, stopped database connections, cancellation, partial results and artifacts with a real browser and temporary PostgreSQL instances. Run the complete suite before opening the dashboard phase.
