import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture } from '../src/capture/engine.ts';
import { desktopProfile } from '../src/capture/policy.ts';
import { compareScreenshots } from '../src/compare/compare.ts';
import { startFixture } from '../src/fixture/server.ts';
import { ArtifactError, DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines, baselineIdentity } from '../src/persistence/baselines.ts';
import { migrate } from '../src/persistence/database.ts';
import { testDatabase } from './support/postgres.ts';

test('content-addressed local artifacts are write-once and verify digest and tenant scope', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'deltaframe-artifacts-'));
  context.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 3 }),
  );
  const artifacts = new DiskArtifacts(root);
  const tenant = randomUUID();
  const data = Buffer.from('test artifact bytes');
  const [first, second] = await Promise.all([
    artifacts.put(tenant, data),
    artifacts.put(tenant, data),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(await artifacts.get(tenant, first!), data);
  await assert.rejects(artifacts.get(randomUUID(), first!), ArtifactError);
  await assert.rejects(artifacts.put('../wrong', data), ArtifactError);

  const destination = join(
    root,
    tenant,
    first!.digest.slice(0, 2),
    `${first!.digest}.png`,
  );
  const corrupt = Buffer.alloc(data.length, 42);
  await writeFile(destination, corrupt);
  await assert.rejects(artifacts.get(tenant, first!), /digest/);
  await assert.rejects(artifacts.put(tenant, data), /digest/);
});

test(
  'real PostgreSQL preserves baseline history across concurrent approvals, rejection and rollback',
  { timeout: 120_000 },
  async (context) => {
    const database = await testDatabase();
    context.after(() => database.close());
    const { pool, directory } = database;
    const version = await pool.query<{ version: string }>('SELECT version()');
    assert.match(version.rows[0]!.version, /^PostgreSQL 18\./);
    context.diagnostic(version.rows[0]!.version);
    await migrate(pool);
    assert.deepEqual(
      (
        await pool.query<{ name: string }>(
          'SELECT name FROM schema_migrations ORDER BY name',
        )
      ).rows.map(({ name }) => name),
      [
        '001_baselines.sql',
        '002_execution.sql',
        '003_analysis.sql',
        '004_ci_ingestion.sql',
      ],
    );

    const projectId = randomUUID();
    const firstOrg = randomUUID();
    const secondOrg = randomUUID();
    const developerId = randomUUID();
    const reviewerId = randomUUID();
    const viewerId = randomUUID();
    const foreignId = randomUUID();
    await pool.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)',
      [firstOrg, 'Harbor', secondOrg, 'Marina'],
    );
    for (const [actor, org, role] of [
      [developerId, firstOrg, 'developer'],
      [reviewerId, firstOrg, 'reviewer'],
      [viewerId, firstOrg, 'viewer'],
      [foreignId, secondOrg, 'admin'],
    ]) {
      await pool.query('INSERT INTO principals (id, subject) VALUES ($1, $2)', [
        actor,
        `test-${actor}`,
      ]);
      await pool.query(
        'INSERT INTO memberships (org_id, principal_id, role) VALUES ($1, $2, $3)',
        [org, actor, role],
      );
    }
    await pool.query(
      'INSERT INTO projects (org_id, id, name) VALUES ($1, $3, $4), ($2, $3, $4)',
      [firstOrg, secondOrg, projectId, 'Commerce'],
    );
    const scope = { organizationId: firstOrg, projectId, actorId: developerId };
    const reviewer = { ...scope, actorId: reviewerId };
    const foreign = {
      organizationId: secondOrg,
      projectId,
      actorId: foreignId,
    };

    const fixture = await startFixture();
    context.after(() => fixture.close());
    const target = {
      path: '/analytics',
      readySelector: 'main[data-ready="true"]',
    };
    const request = { origin: fixture.origin, profile: desktopProfile, target };
    const original = await capture(request);
    fixture.selectVariant('color');
    const changed = await capture(request);
    const keyInfo = {
      environment: 'development',
      checkpoint: 'commerce',
      fixtureVersion: '1',
      target,
      metadata: original.metadata,
    };
    const key = baselineIdentity(keyInfo);
    assert.equal(
      baselineIdentity({ ...keyInfo, metadata: changed.metadata }),
      key,
    );
    assert.notEqual(baselineIdentity({ ...keyInfo, fixtureVersion: '2' }), key);
    assert.notEqual(
      baselineIdentity({ ...keyInfo, environment: 'production' }),
      key,
    );
    assert.notEqual(
      baselineIdentity({ ...keyInfo, target: { ...target, masks: ['.kpi'] } }),
      key,
    );
    assert.notEqual(
      baselineIdentity({
        ...keyInfo,
        metadata: { ...original.metadata, renderer: 'different' },
      }),
      key,
    );
    assert.equal(
      baselineIdentity({
        ...keyInfo,
        jsonFixtures: { '/api': { a: 1, b: 2 } },
      }),
      baselineIdentity({
        ...keyInfo,
        jsonFixtures: { '/api': { b: 2, a: 1 } },
      }),
    );

    const root = join(directory, 'objects');
    const baselines = new Baselines(pool, new DiskArtifacts(root));
    assert.equal(await baselines.active(scope, key), null);
    await writeFile(root, 'temporary filesystem obstruction');
    await assert.rejects(
      baselines.createCandidate(scope, key, null, original),
      ArtifactError,
    );
    assert.deepEqual(await baselines.history(scope, key), []);
    await unlink(root);
    await mkdir(root);

    const first = await baselines.createCandidate(scope, key, null, original);
    const competing = await baselines.createCandidate(
      scope,
      key,
      null,
      original,
    );
    await assert.rejects(
      baselines.review({ ...scope, actorId: viewerId }, first.id, 'approve'),
      { code: 'forbidden' },
    );
    await assert.rejects(baselines.review(foreign, first.id, 'approve'), {
      code: 'not_found',
    });
    await assert.rejects(baselines.artifact(foreign, first.id), {
      code: 'not_found',
    });
    await assert.rejects(
      baselines.history({ ...scope, actorId: foreignId }, key),
      { code: 'not_found' },
    );
    assert.deepEqual(await baselines.history(foreign, key), []);

    const promotions = await Promise.allSettled([
      baselines.review(reviewer, first.id, 'approve'),
      baselines.review(reviewer, competing.id, 'approve'),
    ]);
    assert.equal(
      promotions.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    const successful = promotions.find(
      (result) => result.status === 'fulfilled',
    );
    const stale = promotions.find((result) => result.status === 'rejected');
    assert.equal(stale?.reason.code, 'conflict');
    assert.ok(successful);
    const approved = successful.value;
    assert.equal((await baselines.active(scope, key))?.id, approved.id);
    assert.equal(
      (await baselines.review(reviewer, approved.id, 'approve')).id,
      approved.id,
    );
    const rejected = approved.id === first.id ? competing : first;
    assert.equal(
      (await baselines.review(reviewer, rejected.id, 'reject')).status,
      'rejected',
    );
    assert.ok(
      (await baselines.artifact(scope, approved.id)).equals(original.png),
    );
    assert.equal(
      compareScreenshots(
        await baselines.artifact(scope, approved.id),
        changed.png,
      ).summary.status,
      'changed',
    );

    const candidate = await baselines.createCandidate(
      scope,
      key,
      approved.id,
      changed,
    );
    await baselines.review(reviewer, candidate.id, 'approve');
    assert.equal((await baselines.active(scope, key))?.id, candidate.id);
    await assert.rejects(
      baselines.review(reviewer, approved.id, 'rollback', rejected.id),
      { code: 'conflict' },
    );
    await baselines.review(reviewer, approved.id, 'rollback', candidate.id);
    assert.equal((await baselines.active(scope, key))?.id, approved.id);
    assert.ok(
      (await baselines.artifact(scope, candidate.id)).equals(changed.png),
    );
    assert.deepEqual(
      (await baselines.history(scope, key)).map(({ version }) => version),
      [3, 2, 1],
    );
    assert.deepEqual(
      (
        await pool.query<{ action: string }>(
          'SELECT action FROM baseline_events WHERE org_id = $1 ORDER BY sequence',
          [firstOrg],
        )
      ).rows.map(({ action }) => action),
      [
        'candidate',
        'candidate',
        'approve',
        'reject',
        'candidate',
        'approve',
        'rollback',
      ],
    );
  },
);
