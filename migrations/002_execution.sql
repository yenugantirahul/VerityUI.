CREATE TABLE suite_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  checkpoints jsonb NOT NULL CHECK (jsonb_array_length(checkpoints) BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES principals(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  variant text NOT NULL,
  commit_sha text,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id, suite_id) REFERENCES suite_revisions(org_id, project_id, id),
  UNIQUE (org_id, project_id, actor_id, idempotency_key)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint jsonb NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  result jsonb,
  failure text,
  UNIQUE (run_id, ordinal),
  CHECK ((state = 'running') = (lease_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'completed') = (result IS NOT NULL))
);

CREATE INDEX runs_project_history ON runs(org_id, project_id, sequence DESC);
CREATE INDEX jobs_queued ON jobs(available_at) WHERE state = 'queued';
CREATE INDEX jobs_running ON jobs(lease_until) WHERE state = 'running';

ALTER TABLE baseline_versions ADD COLUMN source_job_id uuid UNIQUE REFERENCES jobs(id);
