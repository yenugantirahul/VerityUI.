import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerExecutionApi, type ExecutionApi } from './execution-api.ts';
import { registerCiApi } from './ci-api.ts';
import { registerMetrics } from './metrics.ts';

export function createApp(
  logger = false,
  execution?: ExecutionApi,
  webRoot?: string,
  metricsToken?: string,
) {
  const app = Fastify({
    logger,
    bodyLimit: 128 * 1024,
    requestTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.get('/healthz', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { status: { type: 'string', const: 'ok' } },
          required: ['status'],
        },
      },
    },
    handler: () => ({ status: 'ok' }),
  });
  if (metricsToken) registerMetrics(app, metricsToken);
  app.get('/readyz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (execution && (await execution.queue.ready())) {
        await execution.artifacts.ready?.();
        return { status: 'ready' };
      }
    } catch {
      // Keep dependency details private.
    }
    return reply.code(503).send({ status: 'unavailable' });
  });
  if (execution) {
    void app.register(cookie);
    void app.register(async (api) => registerExecutionApi(api, execution), {
      prefix: '/api/v1',
    });
    void app.register(async (api) => registerCiApi(api, execution), {
      prefix: '/api/v1/ci',
    });
  }
  if (webRoot) {
    app.addHook('onSend', async (_request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    });
    void app.register(serveStatic, { root: webRoot, index: ['index.html'] });
  }
  return app;
}

export function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4310 : Number(value);
  if (
    !/^\d+$/.test(value ?? '4310') ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
