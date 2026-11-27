import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  executionServices,
  initializeLocalOperator,
} from '../execution/runtime.ts';
import { createApp, parsePort } from './app.ts';

const connection = process.env.DATABASE_URL;
const origin = process.env.VERITYUI_PUBLIC_ORIGIN;
const publicOrigin = origin ? URL.parse(origin) : undefined;
if (
  origin &&
  (!publicOrigin ||
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.href !== `${publicOrigin.origin}/`)
)
  throw new Error('VERITYUI_PUBLIC_ORIGIN must be an HTTPS origin');
const metricsToken = process.env.VERITYUI_METRICS_TOKEN;
if (metricsToken && !/^\S{32,512}$/.test(metricsToken))
  throw new Error(
    'VERITYUI_METRICS_TOKEN must be a secret of at least 32 characters',
  );
const token =
  process.env.VERITYUI_API_TOKEN ?? process.env.DELTAFRAME_API_TOKEN;
if (connection && (!token || !/^\S{32,512}$/.test(token))) {
  throw new Error(
    'Set VERITYUI_API_TOKEN to a random secret of at least 32 characters',
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
    runtime && operator && token
      ? { ...runtime, operator, token, publicOrigin: publicOrigin?.origin }
      : undefined,
    existsSync(webRoot) ? webRoot : undefined,
    metricsToken,
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
