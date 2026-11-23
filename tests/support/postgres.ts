import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { migrate, openDatabase } from '../../src/persistence/database.ts';

const run = promisify(execFile);

async function localPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string')
    throw new Error('Could not select PostgreSQL TCP port');
  return address.port;
}

export async function testDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'deltaframe-db-'));
  const port = await localPort();
  const password = randomBytes(24).toString('hex');
  const logs: string[] = [];
  const log = (value: unknown) => {
    if (logs.length < 40) logs.push(String(value));
  };
  const cluster = new EmbeddedPostgres({
    databaseDir: join(directory, 'postgres'),
    user: 'deltaframe_test',
    password,
    port,
    persistent: true,
    authMethod: 'scram-sha-256',
    autoRehydrateSymlinks: true,
    postgresFlags: ['-h', '127.0.0.1'],
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    onLog: log,
    onError: log,
  });
  const connectionString = `postgresql://deltaframe_test:${password}@127.0.0.1:${port}/postgres`;
  const pool = openDatabase(connectionString);
  let stopCluster: (() => Promise<unknown>) | undefined;
  async function close() {
    await pool.end();
    await stopCluster?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  try {
    await cluster.initialise();
    if (process.platform === 'win32') {
      // pg_ctl starts the postmaster with a restricted Windows token.
      const windowsBinaries = '@embedded-postgres/windows-x64';
      const { pg_ctl } = (await import(windowsBinaries)) as { pg_ctl: string };
      const data = join(directory, 'postgres');
      const logPath = join(directory, 'postgres.log');
      const options = { windowsHide: true, timeout: 30000 };
      try {
        await run(
          pg_ctl,
          [
            'start',
            '-w',
            '-t',
            '15',
            '-D',
            data,
            '-l',
            logPath,
            '-o',
            `-h 127.0.0.1 -p ${port}`,
          ],
          options,
        );
      } catch (error) {
        log(
          await readFile(logPath, 'utf8').catch(
            () => 'Postmaster log unavailable',
          ),
        );
        throw error;
      }
      stopCluster = () =>
        run(pg_ctl, ['stop', '-w', '-m', 'fast', '-D', data], options);
    } else {
      await cluster.start();
      stopCluster = () => cluster.stop();
    }
    await migrate(pool);
    return { directory, pool, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw new Error(
      `PostgreSQL test cluster failed: ${logs.join('\n').replaceAll(password, '[redacted]')}`,
      { cause: error },
    );
  }
}
