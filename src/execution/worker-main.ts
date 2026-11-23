import { executionServices } from './runtime.ts';
import { Worker } from './worker.ts';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const runtime = executionServices(connection);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  await new Worker(runtime.queue, runtime.baselines, runtime.artifacts).run(
    controller.signal,
    (event) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event,
          timestamp: new Date().toISOString(),
        }),
      );
    },
  );
} finally {
  await runtime.pool.end();
}
