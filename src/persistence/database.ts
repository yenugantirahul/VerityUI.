import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';

export function openDatabase(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
}

export async function transaction<T>(
  pool: pg.Pool,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const output = await work(client);
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

export async function migrate(pool: pg.Pool) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error('No migrations found');
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(1928403101)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const installed = await client.query<{ name: string; digest: string }>(
      'SELECT name, digest FROM schema_migrations',
    );
    const known = new Map(
      installed.rows.map(({ name, digest }) => [name, digest]),
    );
    if (installed.rows.some(({ name }) => !files.includes(name))) {
      throw new Error('Database has migrations absent from this build');
    }
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const digest = createHash('sha256')
        .update(sql.replaceAll('\r\n', '\n'))
        .digest('hex');
      const existing = known.get(file);
      if (existing && existing !== digest)
        throw new Error(`Applied migration changed: ${file}`);
      if (existing) continue;
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, digest) VALUES ($1, $2)',
        [file, digest],
      );
    }
  });
}
