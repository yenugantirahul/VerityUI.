CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120)
);

CREATE TABLE principals (
  id uuid PRIMARY KEY,
  subject text NOT NULL UNIQUE
);

CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('admin', 'reviewer', 'developer', 'viewer')),
  PRIMARY KEY (org_id, principal_id)
);

CREATE TABLE projects (
  org_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, name)
);

CREATE TABLE baseline_keys (
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  identity text NOT NULL CHECK (identity ~ '^[0-9a-f]{64}$'),
  active_id uuid,
  PRIMARY KEY (org_id, project_id, identity),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE TABLE baseline_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  identity text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('candidate', 'approved', 'rejected')),
  based_on_id uuid,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  artifact_bytes integer NOT NULL CHECK (artifact_bytes > 0),
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES principals(id),
  UNIQUE (org_id, project_id, identity, id),
  UNIQUE (org_id, project_id, identity, version),
  FOREIGN KEY (org_id, project_id, identity) REFERENCES baseline_keys(org_id, project_id, identity),
  FOREIGN KEY (org_id, project_id, identity, based_on_id) REFERENCES baseline_versions(org_id, project_id, identity, id)
);

ALTER TABLE baseline_keys ADD FOREIGN KEY (org_id, project_id, identity, active_id)
  REFERENCES baseline_versions(org_id, project_id, identity, id);

CREATE TABLE baseline_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  identity text NOT NULL,
  actor_id uuid NOT NULL REFERENCES principals(id),
  action text NOT NULL CHECK (action IN ('candidate', 'approve', 'reject', 'rollback')),
  version_id uuid NOT NULL,
  previous_active_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id, identity, version_id) REFERENCES baseline_versions(org_id, project_id, identity, id),
  FOREIGN KEY (org_id, project_id, identity, previous_active_id) REFERENCES baseline_versions(org_id, project_id, identity, id)
);

CREATE INDEX baseline_events_history ON baseline_events (org_id, project_id, identity, sequence DESC);
