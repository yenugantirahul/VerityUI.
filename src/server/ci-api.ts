import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ExecutionError } from '../execution/errors.ts';
import type { CiCredential } from '../execution/ci.ts';
import { ciRunSchema, maxUploadBytes } from '../verification/contract.ts';
import {
  registerExecutionErrorHandler,
  type ExecutionApi,
} from './execution-api.ts';

export function registerCiApi(app: FastifyInstance, api: ExecutionApi) {
  registerExecutionErrorHandler(app);
  const scopes = new WeakMap<FastifyRequest, CiCredential>();
  const uploads = new Set<FastifyRequest>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'POST') {
      if (uploads.size >= 2) {
        reply.header('Retry-After', '3');
        throw new ExecutionError(429, 'CI uploads are busy. Retry shortly.');
      }
      uploads.add(request);
    }
    const authorization = request.headers.authorization;
    const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1] ?? '';
    scopes.set(request, await api.queue.ci.authenticate(token));
  });
  app.addHook('onResponse', async (request) => {
    uploads.delete(request);
  });
  app.addHook('onRequestAbort', async (request) => {
    uploads.delete(request);
  });

  app.post('/runs', { bodyLimit: maxUploadBytes }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(key))
      throw new ExecutionError(400, 'An Idempotency-Key header is required');
    const upload = ciRunSchema.safeParse(request.body);
    if (!upload.success) {
      const field = upload.error.issues[0]?.path.join('.') || 'payload';
      throw new ExecutionError(400, `Invalid CI run upload at ${field}`);
    }
    const scope = scopes.get(request)!;
    const run = await api.queue.ci.submit(
      scope,
      key,
      upload.data,
      api.artifacts,
    );
    return reply.code(202).send({ ...run, projectId: scope.projectId });
  });
  app.get<{ Params: { runId: string } }>(
    '/runs/:runId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['runId'],
          properties: { runId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    (request) =>
      api.queue.ci.status(scopes.get(request)!, request.params.runId),
  );
}
