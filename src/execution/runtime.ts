import { resolve } from 'node:path';
import { DiskArtifacts } from '../persistence/artifacts.ts';
import { Baselines } from '../persistence/baselines.ts';
import { openDatabase, transaction } from '../persistence/database.ts';
import { RunQueue, type Operator } from './queue.ts';

const localOperator: Operator = {
  organizationId: '3a309538-bbc0-4038-aecc-ea26a2bf13b5',
  actorId: 'dbab9622-1f8f-4b99-8ee6-c2ce551841cf',
};

export function executionServices(
  connection: string,
  directory = process.env.ARTIFACT_DIR ?? resolve('data', 'objects'),
) {
  const pool = openDatabase(connection);
  const artifacts = new DiskArtifacts(directory);
  return {
    pool,
    queue: new RunQueue(pool),
    baselines: new Baselines(pool, artifacts),
    artifacts,
  };
}

export async function initializeLocalOperator(
  pool: ReturnType<typeof openDatabase>,
): Promise<Operator> {
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO organizations (id, name) VALUES ($1, 'Local workspace') ON CONFLICT (id) DO NOTHING`,
      [localOperator.organizationId],
    );
    await client.query(
      `INSERT INTO principals (id, subject) VALUES ($1, 'local-operator') ON CONFLICT (id) DO NOTHING`,
      [localOperator.actorId],
    );
    await client.query(
      `INSERT INTO memberships (org_id, principal_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [localOperator.organizationId, localOperator.actorId],
    );
  });
  return localOperator;
}
