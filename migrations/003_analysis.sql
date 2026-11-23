CREATE TABLE analysis_feedback (
  job_id uuid NOT NULL REFERENCES jobs(id),
  actor_id uuid NOT NULL REFERENCES principals(id),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 80),
  helpful boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, actor_id, version)
);
