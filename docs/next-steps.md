# Next steps

## Phase 3 · Baseline persistence

Add versioned PostgreSQL migrations, a filesystem artifact store for the trusted local deployment, deterministic baseline keys, and transactions for approval, rejection and rollback. Scope each query to the project organization and actor. Use native PostgreSQL integration tests because the Docker engine is unavailable. Test write failures, conflicting approvals and storage integrity before adding API routes or workers.

Run `npm run verify`, including a real PostgreSQL integration suite and temporary filesystem objects. Verify write-once artifacts, distinct baseline identities, change history, stale approval rejection, rollback, tenant and role enforcement, and recovery after transient object write errors.
