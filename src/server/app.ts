import Fastify from 'fastify';
import { registerExecutionApi, type ExecutionApi } from './execution-api.ts';

export function createApp(logger = false, execution?: ExecutionApi) {
  const app = Fastify({
    logger,
    bodyLimit: 128 * 1024,
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
  if (execution) {
    void app.register(async (api) => registerExecutionApi(api, execution), {
      prefix: '/api/v1',
    });
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
