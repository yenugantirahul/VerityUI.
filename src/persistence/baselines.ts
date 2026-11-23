import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CaptureResult } from '../capture/engine.ts';
import type { CaptureRequest } from '../capture/policy.ts';
import { readImage } from '../compare/images.ts';
import { digestOf, type ArtifactStore } from './artifacts.ts';
import { transaction } from './database.ts';

export interface BaselineScope {
  organizationId: string;
  projectId: string;
  actorId: string;
}

export type Role = 'admin' | 'reviewer' | 'developer' | 'viewer';
type ReviewAction = 'approve' | 'reject' | 'rollback';

export interface BaselineVersion {
  id: string;
  identity: string;
  version: number;
  status: 'candidate' | 'approved' | 'rejected';
  based_on_id: string | null;
  artifact_digest: string;
  artifact_bytes: number;
  metadata: CaptureResult['metadata'];
  created_at: Date;
}

export class BaselineError extends Error {
  readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_capture';

  constructor(code: BaselineError['code'], message: string) {
    super(message);
    this.name = 'BaselineError';
    this.code = code;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${Array.from(value, canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function baselineIdentity(input: {
  environment: string;
  checkpoint: string;
  fixtureVersion: string;
  authenticationProfile?: string;
  target: CaptureRequest['target'];
  jsonFixtures?: CaptureRequest['jsonFixtures'];
  metadata: CaptureResult['metadata'];
}) {
  const {
    browser,
    browserVersion,
    viewport,
    deviceScaleFactor,
    locale,
    timezoneId,
    clock,
    platform,
    architecture,
    osRelease,
    renderer,
  } = input.metadata;
  return digestOf(
    Buffer.from(
      canonical({
        captureVersion: 1,
        environment: input.environment,
        checkpoint: input.checkpoint,
        fixtureVersion: input.fixtureVersion,
        authenticationProfile: input.authenticationProfile,
        target: input.target,
        jsonFixtures: JSON.parse(
          JSON.stringify(input.jsonFixtures ?? {}),
        ) as unknown,
        browser,
        browserVersion,
        viewport,
        deviceScaleFactor,
        locale,
        timezoneId,
        clock,
        platform,
        architecture,
        osRelease,
        renderer,
      }),
    ),
  );
}

const versionColumns =
  'id, identity, version, status, based_on_id, artifact_digest, artifact_bytes, metadata, created_at';
const keyCondition = 'org_id = $1 AND project_id = $2 AND identity = $3';

export async function authorizeProject(
  database: Pool | PoolClient,
  scope: BaselineScope,
  allowed?: readonly Role[],
) {
  const { rows } = await database.query<{ role: Role }>(
    `
    SELECT member.role
    FROM memberships AS member
    JOIN projects AS project ON project.org_id = member.org_id
    WHERE member.org_id = $1 AND project.id = $2 AND member.principal_id = $3
    FOR SHARE OF member, project
  `,
    [scope.organizationId, scope.projectId, scope.actorId],
  );
  if (!rows[0]) throw new BaselineError('not_found', 'Project was not found');
  if (allowed && !allowed.includes(rows[0].role)) {
    throw new BaselineError(
      'forbidden',
      'The current role cannot perform this operation',
    );
  }
}

function reference(version: BaselineVersion) {
  return { digest: version.artifact_digest, sizeBytes: version.artifact_bytes };
}

export class Baselines {
  private readonly database: Pool;
  private readonly artifacts: ArtifactStore;

  constructor(database: Pool, artifacts: ArtifactStore) {
    this.database = database;
    this.artifacts = artifacts;
  }

  async active(scope: BaselineScope, identity: string) {
    await authorizeProject(this.database, scope);
    const { rows } = await this.database.query<BaselineVersion>(
      `
      SELECT ${versionColumns} FROM baseline_versions
      WHERE ${keyCondition} AND id = (SELECT active_id FROM baseline_keys WHERE ${keyCondition})
    `,
      [scope.organizationId, scope.projectId, identity],
    );
    return rows[0] ?? null;
  }

  async history(scope: BaselineScope, identity: string) {
    await authorizeProject(this.database, scope);
    const { rows } = await this.database.query<BaselineVersion>(
      `
      SELECT ${versionColumns} FROM baseline_versions WHERE ${keyCondition} ORDER BY version DESC
    `,
      [scope.organizationId, scope.projectId, identity],
    );
    return rows;
  }

  async artifact(scope: BaselineScope, id: string) {
    await authorizeProject(this.database, scope);
    const version = await this.findVersion(this.database, scope, id);
    return this.artifacts.get(scope.organizationId, reference(version));
  }

  async candidateForJob(scope: BaselineScope, jobId: string) {
    await authorizeProject(this.database, scope);
    const { rows } = await this.database.query<BaselineVersion>(
      `
      SELECT ${versionColumns} FROM baseline_versions WHERE org_id = $1 AND project_id = $2 AND source_job_id = $3
    `,
      [scope.organizationId, scope.projectId, jobId],
    );
    return rows[0] ?? null;
  }

  async createCandidate(
    scope: BaselineScope,
    identity: string,
    basedOn: string | null,
    capture: CaptureResult,
    sourceJobId?: string,
  ) {
    const allowed = ['admin', 'reviewer', 'developer'] as const;
    await authorizeProject(this.database, scope, allowed);
    const image = readImage(capture.png);
    if (
      !/^[0-9a-f]{64}$/.test(identity) ||
      capture.metadata.sha256 !== digestOf(capture.png) ||
      capture.metadata.sizeBytes !== capture.png.length ||
      capture.metadata.width !== image.width ||
      capture.metadata.height !== image.height
    ) {
      throw new BaselineError(
        'invalid_capture',
        'Capture metadata does not match the artifact',
      );
    }
    const artifact = await this.artifacts.put(
      scope.organizationId,
      capture.png,
    );
    return transaction(this.database, async (client) => {
      await authorizeProject(client, scope, allowed);
      const key = [scope.organizationId, scope.projectId, identity];
      await client.query(
        `INSERT INTO baseline_keys (org_id, project_id, identity) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        key,
      );
      const { rows: pointers } = await client.query<{
        active_id: string | null;
      }>(
        `SELECT active_id FROM baseline_keys WHERE ${keyCondition} FOR UPDATE`,
        key,
      );
      const active = pointers[0]!.active_id;
      if (sourceJobId) {
        const existing = await client.query<BaselineVersion>(
          `SELECT ${versionColumns} FROM baseline_versions WHERE ${keyCondition} AND source_job_id = $4`,
          [...key, sourceJobId],
        );
        if (existing.rows[0]) return existing.rows[0];
        const job = await client.query(
          `
          SELECT jobs.id FROM jobs JOIN runs ON runs.id = jobs.run_id
          WHERE runs.org_id = $1 AND runs.project_id = $2 AND jobs.result->>'identity' = $3
            AND jobs.id = $4 AND jobs.state = 'completed'
        `,
          [...key, sourceJobId],
        );
        if (!job.rowCount)
          throw new BaselineError('not_found', 'Source capture was not found');
      }
      if (active !== basedOn)
        throw new BaselineError(
          'conflict',
          'The active baseline changed after comparison',
        );
      const { rows } = await client.query<BaselineVersion>(
        `
        INSERT INTO baseline_versions (org_id, project_id, identity, id, version, status, based_on_id, artifact_digest, artifact_bytes, metadata, created_by, source_job_id)
        VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(version), 0) + 1 FROM baseline_versions WHERE ${keyCondition}), 'candidate', $5, $6, $7, $8, $9, $10)
        RETURNING ${versionColumns}
      `,
        [
          ...key,
          randomUUID(),
          basedOn,
          artifact.digest,
          artifact.sizeBytes,
          capture.metadata,
          scope.actorId,
          sourceJobId ?? null,
        ],
      );
      const version = rows[0]!;
      await this.record(client, scope, version, 'candidate', active);
      return version;
    });
  }

  async review(
    scope: BaselineScope,
    id: string,
    action: ReviewAction,
    expectedActive?: string | null,
  ) {
    return transaction(this.database, async (client) => {
      await authorizeProject(client, scope, ['admin', 'reviewer']);
      const { identity } = await this.findVersion(client, scope, id);
      const key = [scope.organizationId, scope.projectId, identity];
      const { rows: pointers } = await client.query<{
        active_id: string | null;
      }>(
        `SELECT active_id FROM baseline_keys WHERE ${keyCondition} FOR UPDATE`,
        key,
      );
      const active = pointers[0]!.active_id;
      const version = await this.findVersion(client, scope, id);

      if (
        action === 'approve' &&
        version.status === 'approved' &&
        active === id
      )
        return version;
      if (action === 'reject' && version.status === 'rejected') return version;
      if (action === 'rollback') {
        if (version.status !== 'approved' || expectedActive !== active) {
          throw new BaselineError(
            'conflict',
            'Rollback requires an approved version and the observed active identifier',
          );
        }
        if (active === id) return version;
      } else if (
        version.status !== 'candidate' ||
        (action === 'approve' && version.based_on_id !== active)
      ) {
        throw new BaselineError(
          'conflict',
          'The candidate or its active baseline changed',
        );
      }

      if (action !== 'reject')
        await this.artifacts.get(scope.organizationId, reference(version));
      if (action !== 'rollback') {
        version.status = action === 'approve' ? 'approved' : 'rejected';
        await client.query(
          `UPDATE baseline_versions SET status = $5 WHERE ${keyCondition} AND id = $4`,
          [...key, id, version.status],
        );
      }
      if (action !== 'reject') {
        await client.query(
          `UPDATE baseline_keys SET active_id = $4 WHERE ${keyCondition}`,
          [...key, id],
        );
      }
      await this.record(client, scope, version, action, active);
      return version;
    });
  }

  private async findVersion(
    database: Pool | PoolClient,
    scope: BaselineScope,
    id: string,
  ) {
    const { rows } = await database.query<BaselineVersion>(
      `
      SELECT ${versionColumns} FROM baseline_versions WHERE org_id = $1 AND project_id = $2 AND id = $3
    `,
      [scope.organizationId, scope.projectId, id],
    );
    if (!rows[0])
      throw new BaselineError('not_found', 'Baseline version was not found');
    return rows[0];
  }

  private async record(
    client: PoolClient,
    scope: BaselineScope,
    version: BaselineVersion,
    action: 'candidate' | ReviewAction,
    active: string | null,
  ) {
    await client.query(
      `
      INSERT INTO baseline_events (org_id, project_id, identity, actor_id, action, version_id, previous_active_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [
        scope.organizationId,
        scope.projectId,
        version.identity,
        scope.actorId,
        action,
        version.id,
        active,
      ],
    );
  }
}
