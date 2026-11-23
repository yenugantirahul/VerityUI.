import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  executionServices,
  initializeLocalOperator,
} from '../execution/runtime.ts';
import { createApp, parsePort } from './app.ts';

const connection = process.env.DATABASE_URL;
const token = process.env.DELTAFRAME_API_TOKEN;
if (connection && (!token || !/^\S{32,512}$/.test(token))) {
  throw new Error(
    'Set DELTAFRAME_API_TOKEN to a random secret of at least 32 characters',
  );
}
const runtime = connection ? executionServices(connection) : undefined;
const webRoot = resolve('web-dist');
let app: ReturnType<typeof createApp> | undefined;

try {
  const operator = runtime
    ? await initializeLocalOperator(runtime.pool)
    : undefined;
  app = createApp(
    true,
    runtime && operator && token ? { ...runtime, operator, token } : undefined,
    existsSync(webRoot) ? webRoot : undefined,
  );
  if (runtime) app.addHook('onClose', () => runtime.pool.end());
  await app.listen({ host: '127.0.0.1', port: parsePort(process.env.PORT) });
} catch {
  if (app) await app.close();
  else await runtime?.pool.end();
  console.error(
    'Service startup failed. Check the local port, database connection and migrations.',
  );
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app?.close().catch(() => {
      console.error('Service shutdown failed');
      process.exitCode = 1;
    });
  });
}
