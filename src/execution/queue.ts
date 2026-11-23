import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CaptureResult } from '../capture/engine.ts';
import type { ComparisonSummary } from '../compare/compare.ts';
import type { FixtureVariant } from '../fixture/page.ts';
import { digestOf, type ArtifactRef } from '../persistence/artifacts.ts';
import {
  authorizeProject,
  BaselineError,
  type BaselineScope,
  type Role,
} from '../persistence/baselines.ts';
import { transaction } from '../persistence/database.ts';

export interface Checkpoint {
  key: string;
  width: number;
  height: number;
  selector?: string;
  masks?: string[];
}

export type JobState =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Evidence = 'current' | 'baseline' | 'diff' | 'heatmap' | 'overlay';
export type Operator = Omit<BaselineScope, 'projectId'>;

export interface JobResult {
  identity: string;
  comparedBaselineId: string | null;
  capture: CaptureResult['metadata'];
  comparison: ComparisonSummary;
  evidence: Partial<Record<Evidence, ArtifactRef>>;
}

export interface JobDetail {
  id: string;
  checkpoint: Checkpoint;
  state: JobState;
  attempts: number;
  failure: string | null;
  result: JobResult | null;
}

interface RunRequest {
  suiteId: string;
  variant: FixtureVariant;
  commitSha?: string;
}

interface Run {
  id: string;
  suite_id: string;
  variant: FixtureVariant;
  commit_sha: string | null;
  created_at: Date;
}

export interface Claim {
  id: string;
  lease_id: string;
  checkpoint: Checkpoint;
  attempts: number;
  org_id: string;
  project_id: string;
  actor_id: string;
  variant: FixtureVariant;
}

export class ExecutionError extends Error {
  readonly status: 400 | 404 | 409 | 429;

  constructor(status: ExecutionError['status'], message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.status = status;
  }
}

const projectKey = 'org_id = $1 AND project_id = $2';
const runColumns = 'id, suite_id, variant, commit_sha, created_at';
const jobColumns = 'id, checkpoint, state, attempts, failure, result';
const canRun = ['admin', 'developer', 'reviewer'] as const;

export class RunQueue {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async workspaces(actorId: string) {
    return (
      await this.pool.query<{ id: string; name: string }>(
        `
      SELECT o.id, o.name FROM organizations o JOIN memberships m ON m.org_id = o.id
      WHERE m.principal_id = $1 ORDER BY o.name, o.id
    `,
        [actorId],
      )
    ).rows;
  }

  async projects(actor: Operator) {
    return (
      await this.pool.query<{ id: string; name: string }>(
        `
      SELECT p.id, p.name FROM projects p JOIN memberships m USING (org_id)
      WHERE p.org_id = $1 AND m.principal_id = $2 ORDER BY p.name LIMIT 100
    `,
        [actor.organizationId, actor.actorId],
      )
    ).rows;
  }

  async createProject(actor: Operator, name: string) {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<{ role: Role }>(
        `
        SELECT role FROM memberships WHERE org_id = $1 AND principal_id = $2 FOR SHARE
      `,
        [actor.organizationId, actor.actorId],
      );
      if (rows[0]?.role !== 'admin')
        throw new BaselineError(
          'forbidden',
          'Project creation requires an administrator',
        );
      const project = await client.query<{ id: string; name: string }>(
        `
        INSERT INTO projects (org_id, id, name) VALUES ($1, $2, $3)
        ON CONFLICT (org_id, name) DO NOTHING RETURNING id, name
      `,
        [actor.organizationId, randomUUID(), name],
      );
      if (!project.rows[0])
        throw new ExecutionError(
          409,
          'A project with this name already exists',
        );
      return project.rows[0];
    });
  }

  async createSuite(scope: BaselineScope, checkpoints: Checkpoint[]) {
    if (
      new Set(checkpoints.map(({ key }) => key)).size !== checkpoints.length
    ) {
      throw new ExecutionError(400, 'Checkpoint keys must be unique');
    }
    return transaction(this.pool, async (client) => {
      await authorizeProject(client, scope, canRun);
      const { rows } = await client.query<{
        id: string;
        checkpoints: Checkpoint[];
      }>(
        `
        INSERT INTO suite_revisions (org_id, project_id, id, checkpoints) VALUES ($1, $2, $3, $4)
        RETURNING id, checkpoints
      `,
        [
          scope.organizationId,
          scope.projectId,
          randomUUID(),
          JSON.stringify(checkpoints),
        ],
      );
      return rows[0]!;
    });
  }

  async latestSuite(scope: BaselineScope) {
    await authorizeProject(this.pool, scope);
    const { rows } = await this.pool.query<{
      id: string;
      checkpoints: Checkpoint[];
    }>(
      `
      SELECT id, checkpoints FROM suite_revisions WHERE ${projectKey} ORDER BY sequence DESC LIMIT 1
    `,
      [scope.organizationId, scope.projectId],
    );
    return rows[0] ?? null;
  }

  async submit(scope: BaselineScope, key: string, request: RunRequest) {
    const requestHash = digestOf(
      Buffer.from(
        JSON.stringify([
          request.suiteId,
          request.variant,
          request.commitSha ?? null,
        ]),
      ),
    );
    return transaction(this.pool, async (client) => {
      await client.query(
        'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
        [scope.organizationId],
      );
      await authorizeProject(client, scope, canRun);
      const project = [scope.organizationId, scope.projectId];
      const prior = await client.query<Run & { request_digest: string }>(
        `
        SELECT ${runColumns}, request_digest FROM runs WHERE ${projectKey} AND actor_id = $3 AND idempotency_key = $4
      `,
        [...project, scope.actorId, key],
      );
      const existing = prior.rows[0];
      if (existing) {
        if (existing.request_digest !== requestHash)
          throw new ExecutionError(
            409,
            'Idempotency key already belongs to a different request',
          );
        const { id, suite_id, variant, commit_sha, created_at } = existing;
        return { id, suite_id, variant, commit_sha, created_at };
      }
      const quota = await client.query<{ count: number }>(
        `
        SELECT count(*)::integer AS count FROM jobs JOIN runs ON runs.id = jobs.run_id
        WHERE runs.org_id = $1 AND jobs.state IN ('queued', 'running')
      `,
        [scope.organizationId],
      );
      const suite = await client.query<{ checkpoints: Checkpoint[] }>(
        `
        SELECT checkpoints FROM suite_revisions WHERE ${projectKey} AND id = $3
      `,
        [...project, request.suiteId],
      );
      const checkpoints = suite.rows[0]?.checkpoints;
      if (!checkpoints)
        throw new ExecutionError(404, 'Suite revision was not found');
      if (quota.rows[0]!.count + checkpoints.length > 48)
        throw new ExecutionError(429, 'Organization job quota exceeded');
      const { rows } = await client.query<Run>(
        `
        INSERT INTO runs(id, org_id, project_id, suite_id, actor_id, variant, commit_sha, idempotency_key, request_digest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${runColumns}
      `,
        [
          randomUUID(),
          ...project,
          request.suiteId,
          scope.actorId,
          request.variant,
          request.commitSha ?? null,
          key,
          requestHash,
        ],
      );
      const run = rows[0]!;
      for (const [ordinal, checkpoint] of checkpoints.entries()) {
        await client.query(
          'INSERT INTO jobs (id, run_id, checkpoint, ordinal) VALUES ($1, $2, $3, $4)',
          [randomUUID(), run.id, checkpoint, ordinal],
        );
      }
      return run;
    });
  }

  async list(scope: BaselineScope, limit: number, before?: string) {
    await authorizeProject(this.pool, scope);
    return (
      await this.pool.query<Run & { states: JobState[] }>(
        `
      SELECT ${runColumns}, ARRAY(SELECT state FROM jobs WHERE run_id = runs.id ORDER BY ordinal) AS states
      FROM runs WHERE ${projectKey} AND ($3::uuid IS NULL OR sequence < (SELECT sequence FROM runs WHERE ${projectKey} AND id = $3))
      ORDER BY sequence DESC LIMIT $4
    `,
        [scope.organizationId, scope.projectId, before ?? null, limit],
      )
    ).rows;
  }

  async detail(scope: BaselineScope, id: string) {
    await authorizeProject(this.pool, scope);
    const runs = await this.pool.query<Run>(
      `SELECT ${runColumns} FROM runs WHERE ${projectKey} AND id = $3`,
      [scope.organizationId, scope.projectId, id],
    );
    const run = runs.rows[0];
    if (!run) throw new ExecutionError(404, 'Run was not found');
    const jobs = await this.pool.query<JobDetail>(
      `SELECT ${jobColumns} FROM jobs WHERE run_id = $1 ORDER BY ordinal`,
      [id],
    );
    return { ...run, jobs: jobs.rows };
  }

  async cancel(scope: BaselineScope, id: string) {
    await transaction(this.pool, async (client) => {
      await authorizeProject(client, scope, canRun);
      await client.query(
        `
        UPDATE jobs SET state = 'cancelled', lease_id = NULL, lease_until = NULL
        WHERE run_id = (SELECT id FROM runs WHERE ${projectKey} AND id = $3) AND state IN ('queued', 'running')
      `,
        [scope.organizationId, scope.projectId, id],
      );
    });
    return this.detail(scope, id);
  }

  async claim() {
    await this.pool.query(`
      UPDATE jobs SET state = 'failed', failure = 'lease_expired', lease_id = NULL, lease_until = NULL
      WHERE state = 'running' AND lease_until <= now() AND attempts = 3
    `);
    const { rows } = await this.pool.query<Claim>(
      `
      WITH next_job AS (
        SELECT jobs.id FROM jobs WHERE attempts < 3 AND
          ((state = 'queued' AND available_at <= now()) OR (state = 'running' AND lease_until <= now()))
        ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs SET state = 'running', attempts = attempts + 1,
        lease_id = $1, lease_until = now() + interval '45 seconds', failure = NULL
      FROM next_job, runs WHERE jobs.id = next_job.id AND runs.id = jobs.run_id
      RETURNING jobs.id, jobs.checkpoint, jobs.lease_id, jobs.attempts, runs.org_id,
        runs.project_id, runs.actor_id, runs.variant
    `,
      [randomUUID()],
    );
    return rows[0] ?? null;
  }

  async complete(claim: Claim, result: JobResult) {
    const update = await this.pool.query(
      `
      UPDATE jobs SET state = 'completed', result = $3, lease_id = NULL, lease_until = NULL
      WHERE id = $1 AND lease_id = $2 AND state = 'running' AND lease_until > now()
    `,
      [claim.id, claim.lease_id, result],
    );
    return update.rowCount === 1;
  }

  async fail(claim: Claim, failure: string, retryable: boolean) {
    const next = retryable && claim.attempts < 3 ? 'queued' : 'failed';
    const update = await this.pool.query(
      `
      UPDATE jobs SET state = $3, failure = $4, lease_id = NULL, lease_until = NULL,
        available_at = now() + (attempts * interval '1 second')
      WHERE id = $1 AND lease_id = $2 AND state = 'running' AND lease_until > now()
    `,
      [claim.id, claim.lease_id, next, failure],
    );
    return update.rowCount === 1;
  }
}
