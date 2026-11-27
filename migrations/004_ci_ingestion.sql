CREATE TABLE ci_credentials (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES principals(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  baseline_branch text NOT NULL CHECK (length(baseline_branch) BETWEEN 1 AND 160),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at timestamptz,
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE INDEX ci_credentials_project ON ci_credentials (org_id, project_id);

ALTER TABLE runs ALTER COLUMN suite_id DROP NOT NULL;
ALTER TABLE runs ADD COLUMN branch text;
ALTER TABLE runs ADD COLUMN baseline_branch text;
ALTER TABLE runs ADD COLUMN ci_credential_id uuid REFERENCES ci_credentials(id);
ALTER TABLE runs ADD CONSTRAINT runs_source_shape CHECK (
  (variant = 'ci' AND suite_id IS NULL AND commit_sha IS NOT NULL AND branch IS NOT NULL
    AND baseline_branch IS NOT NULL AND ci_credential_id IS NOT NULL)
  OR
  (variant <> 'ci' AND suite_id IS NOT NULL AND branch IS NULL AND baseline_branch IS NULL
    AND ci_credential_id IS NULL)
);
CREATE UNIQUE INDEX ci_runs_idempotency ON runs (org_id, project_id, idempotency_key) WHERE variant = 'ci';
CREATE INDEX runs_project_metrics ON runs (org_id, project_id, created_at);

ALTER TABLE jobs ADD COLUMN uploaded_evidence jsonb;
ALTER TABLE jobs ADD COLUMN started_at timestamptz;
ALTER TABLE jobs ADD COLUMN finished_at timestamptz;
