import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CaptureResult } from '../capture/engine.ts';
import { InvalidImageError, readImageSize } from '../compare/images.ts';
import {
  digestOf,
  type ArtifactRef,
  type ArtifactStore,
} from '../persistence/artifacts.ts';
import {
  authorizeProject,
  type BaselineScope,
} from '../persistence/baselines.ts';
import { transaction } from '../persistence/database.ts';
import {
  maxScreenshotBytes,
  maxScreenshotPixels,
  maxSnapshotBytes,
  snapshotSchema,
  type ciRunSchema,
} from '../verification/contract.ts';
import type { z } from 'zod';
import { ExecutionError } from './errors.ts';

export interface UploadedEvidence {
  identity: string;
  frame: ArtifactRef;
  snapshot?: ArtifactRef;
  metadata: CaptureResult['metadata'];
}

interface CredentialRow {
  id: string;
  label: string;
  baseline_branch: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface CiCredential extends BaselineScope {
  id: string;
  baselineBranch: string;
}

const visible =
  'id, label, baseline_branch, created_at, expires_at, revoked_at';
const credentialPattern = /^vui_ci_[A-Za-z0-9_-]{43}$/;

function parseUpload(
  capture: z.output<typeof ciRunSchema>['captures'][number],
) {
  const png = Buffer.from(capture.image, 'base64');
  const { metadata } = capture;
  try {
    const size = readImageSize(png, maxScreenshotPixels);
    if (
      png.length > maxScreenshotBytes ||
      png.length !== metadata.sizeBytes ||
      size.width !== metadata.width ||
      size.height !== metadata.height ||
      digestOf(png) !== metadata.sha256
    )
      throw new InvalidImageError('Capture metadata does not match its image');
  } catch (error) {
    if (!(error instanceof InvalidImageError)) throw error;
    throw new ExecutionError(
      400,
      'A screenshot failed PNG limits or integrity checks',
    );
  }
  let structure: Buffer | undefined;
  if (capture.snapshot) {
    try {
      const bytes = Buffer.from(capture.snapshot, 'base64');
      if (bytes.length > maxSnapshotBytes)
        throw new Error('Snapshot exceeds budget');
      structure = Buffer.from(
        JSON.stringify(
          snapshotSchema.parse(JSON.parse(bytes.toString('utf8'))),
        ),
      );
      if (structure.length > maxSnapshotBytes)
        throw new Error('Snapshot exceeds budget');
    } catch {
      throw new ExecutionError(
        400,
        'A structural snapshot failed integrity checks or exceeded its budget',
      );
    }
  }
  return {
    key: capture.key,
    route: capture.route,
    identity: capture.identity,
    metadata,
    png,
    structure,
  };
}

export class CiIngress {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async list(scope: BaselineScope) {
    await authorizeProject(this.pool, scope, ['admin']);
    const { rows } = await this.pool.query<CredentialRow>(
      `SELECT ${visible} FROM ci_credentials WHERE org_id = $1 AND project_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [scope.organizationId, scope.projectId],
    );
    return rows;
  }

  async issue(scope: BaselineScope, label: string, baselineBranch: string) {
    return transaction(this.pool, async (client) => {
      await this.lockProject(client, scope);
      await authorizeProject(client, scope, ['admin']);
      const token = `vui_ci_${randomBytes(32).toString('base64url')}`;
      const { rows } = await client.query<CredentialRow>(
        `INSERT INTO ci_credentials (id, org_id, project_id, owner_id, label, baseline_branch, digest)
         SELECT $1, $2, $3, $4, $5, $6, $7 WHERE (
           SELECT count(*) FROM ci_credentials WHERE org_id = $2 AND project_id = $3
           AND revoked_at IS NULL AND expires_at > now()
         ) < 8 RETURNING ${visible}`,
        [
          randomUUID(),
          scope.organizationId,
          scope.projectId,
          scope.actorId,
          label,
          baselineBranch,
          digestOf(Buffer.from(token)),
        ],
      );
      if (!rows[0])
        throw new ExecutionError(
          429,
          'This project already has eight active CI credentials',
        );
      return { ...rows[0], token };
    });
  }

  async revoke(scope: BaselineScope, id: string) {
    await authorizeProject(this.pool, scope, ['admin']);
    const result = await this.pool.query(
      'UPDATE ci_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id = $1 AND project_id = $2 AND id = $3',
      [scope.organizationId, scope.projectId, id],
    );
    if (!result.rowCount)
      throw new ExecutionError(404, 'CI credential was not found');
  }

  async authenticate(token: string): Promise<CiCredential> {
    if (!credentialPattern.test(token))
      throw new ExecutionError(
        401,
        'A valid project CI credential is required',
      );
    const { rows } = await this.pool.query<CiCredential>(
      `SELECT id, org_id AS "organizationId", project_id AS "projectId",
       owner_id AS "actorId", baseline_branch AS "baselineBranch"
       FROM ci_credentials WHERE digest = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [digestOf(Buffer.from(token))],
    );
    if (!rows[0])
      throw new ExecutionError(
        401,
        'A valid project CI credential is required',
      );
    return rows[0];
  }

  private async lockProject(client: PoolClient, scope: BaselineScope) {
    await client.query(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [scope.organizationId],
    );
  }

  async submit(
    scope: CiCredential,
    idempotencyKey: string,
    upload: z.output<typeof ciRunSchema>,
    artifacts: ArtifactStore,
  ) {
    const keys = new Set(upload.captures.map(({ key }) => key.toLowerCase()));
    if (keys.size !== upload.captures.length)
      throw new ExecutionError(400, 'Capture keys must be unique');
    const hash = digestOf(
      Buffer.from(JSON.stringify([scope.baselineBranch, upload])),
    );
    const key = `ci:${idempotencyKey}`;
    const project = [scope.organizationId, scope.projectId];
    return transaction(this.pool, async (client) => {
      await this.lockProject(client, scope);
      await authorizeProject(client, scope, ['admin', 'developer']);
      const credential = await client.query(
        'SELECT id FROM ci_credentials WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() FOR SHARE',
        [scope.id],
      );
      if (!credential.rowCount)
        throw new ExecutionError(
          401,
          'A valid project CI credential is required',
        );
      const prior = await client.query<{ id: string; request_digest: string }>(
        "SELECT id, request_digest FROM runs WHERE org_id = $1 AND project_id = $2 AND variant = 'ci' AND idempotency_key = $3",
        [...project, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== hash)
          throw new ExecutionError(
            409,
            'Idempotency key already belongs to a different upload',
          );
        return { id: prior.rows[0].id };
      }
      const quota = await client.query<{ pending: number; recent: number }>(
        `SELECT
          (SELECT count(*)::int FROM jobs JOIN runs ON runs.id = jobs.run_id
           WHERE runs.org_id = $1 AND jobs.state IN ('queued', 'running')) AS pending,
          (SELECT count(*)::int FROM runs WHERE org_id = $1 AND project_id = $2
           AND variant = 'ci' AND created_at >= now() - interval '24 hours') AS recent`,
        project,
      );
      if (
        quota.rows[0]!.pending + keys.size > 48 ||
        quota.rows[0]!.recent >= 100
      )
        throw new ExecutionError(
          429,
          'CI upload quota reached. Retry after in-flight runs finish or the daily window resets.',
        );
      const captures = upload.captures.map(parseUpload);
      const id = randomUUID();
      await client.query(
        `INSERT INTO runs (id, org_id, project_id, actor_id, variant, commit_sha, idempotency_key,
         request_digest, branch, baseline_branch, ci_credential_id)
         VALUES ($1, $2, $3, $4, 'ci', $5, $6, $7, $8, $9, $10)`,
        [
          id,
          ...project,
          scope.actorId,
          upload.commit,
          key,
          hash,
          upload.branch,
          scope.baselineBranch,
          scope.id,
        ],
      );
      for (const [ordinal, capture] of captures.entries()) {
        const frame = await artifacts.put(scope.organizationId, capture.png);
        const snapshot =
          capture.structure &&
          (await artifacts.put(scope.organizationId, capture.structure));
        const { route, metadata } = capture;
        const input: UploadedEvidence = {
          identity: digestOf(
            Buffer.from(
              JSON.stringify([
                'ci-v1',
                scope.baselineBranch,
                route,
                capture.key,
                capture.identity,
                metadata.browser,
                metadata.browserVersion,
                metadata.viewport,
                metadata.renderer,
              ]),
            ),
          ),
          frame,
          snapshot,
          metadata,
        };
        await client.query(
          'INSERT INTO jobs (id, run_id, checkpoint, ordinal, uploaded_evidence) VALUES ($1, $2, $3, $4, $5)',
          [
            randomUUID(),
            id,
            {
              key: capture.key,
              route,
              ...metadata.viewport,
              browser: metadata.browser,
            },
            ordinal,
            input,
          ],
        );
      }
      return { id };
    });
  }

  async status(scope: CiCredential, runId: string) {
    await authorizeProject(this.pool, scope);
    const { rows } = await this.pool.query<{
      state: string;
      attention: boolean | null;
    }>(
      `SELECT jobs.state, (jobs.result->'comparison'->>'status' <> 'matched'
       OR COALESCE(jobs.result->'structure'->>'incomplete', 'false') = 'true'
       OR jsonb_array_length(COALESCE(jobs.result->'structure'->'changes', '[]'::jsonb)) > 0) AS attention
       FROM jobs JOIN runs ON jobs.run_id = runs.id WHERE runs.org_id = $1 AND runs.project_id = $2
       AND runs.id = $3 AND runs.variant = 'ci' ORDER BY jobs.ordinal`,
      [scope.organizationId, scope.projectId, runId],
    );
    if (!rows.length) throw new ExecutionError(404, 'CI run was not found');
    const state = rows.some(
      ({ state }) => state === 'running' || state === 'queued',
    )
      ? 'pending'
      : rows.some(({ state }) => state !== 'completed')
        ? 'inconclusive'
        : rows.some(({ attention }) => attention !== false)
          ? 'review_required'
          : 'passed';
    return { id: runId, status: state, checkpoints: rows.length };
  }

  async baselineSnapshot(scope: BaselineScope, baselineId: string) {
    const { rows } = await this.pool.query<{ snapshot: ArtifactRef | null }>(
      `SELECT j.uploaded_evidence->'snapshot' AS snapshot FROM baseline_versions b
       JOIN jobs j ON b.source_job_id = j.id JOIN runs r ON r.id = j.run_id
       WHERE b.id = $1 AND b.org_id = $2 AND b.project_id = $3 AND r.org_id = $2 AND r.project_id = $3`,
      [baselineId, scope.organizationId, scope.projectId],
    );
    return rows[0]?.snapshot;
  }
}
