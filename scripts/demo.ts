import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { RunQueue } from '../src/execution/queue.ts';
import { initializeLocalOperator } from '../src/execution/runtime.ts';
import { Worker } from '../src/execution/worker.ts';
import { DiskArtifacts } from '../src/persistence/artifacts.ts';
import { Baselines } from '../src/persistence/baselines.ts';
import { createApp, parsePort } from '../src/server/app.ts';
import { testDatabase } from '../tests/support/postgres.ts';

const webRoot = resolve('web-dist');
await access(join(webRoot, 'index.html')).catch(() => {
  throw new Error('Run npm run build before launching the demo');
});
const database = await testDatabase();
let app: ReturnType<typeof createApp> | undefined;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const queue = new RunQueue(database.pool);
  const artifacts = new DiskArtifacts(join(database.directory, 'objects'));
  const baselines = new Baselines(database.pool, artifacts);
  const operator = await initializeLocalOperator(database.pool);
  const project = await queue.createProject(operator, 'Harbor Analytics');
  await queue.createSuite({ ...operator, projectId: project.id }, [
    { key: 'desktop', width: 1200, height: 800 },
  ]);
  const token = randomBytes(32).toString('base64url');
  app = createApp(
    false,
    { token, operator, queue, baselines, artifacts },
    webRoot,
  );
  const address = await app.listen({
    host: '127.0.0.1',
    port: parsePort(process.env.PORT),
  });
  console.log(
    `Dashboard ${address}\nTemporary operator token ${token}\nPress Ctrl+C to stop and remove this demo workspace.`,
  );
  await new Worker(queue, baselines, artifacts).run(
    controller.signal,
    (event) => console.error(event),
  );
} finally {
  await app?.close();
  await database.close();
}
