import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ExecutionError,
  type Checkpoint,
  type Evidence,
  type JobResult,
  type Operator,
  type RunQueue,
} from '../execution/queue.ts';
import { fixtureVariants, type FixtureVariant } from '../fixture/page.ts';
import { ArtifactError, type ArtifactStore } from '../persistence/artifacts.ts';
import { BaselineError, type Baselines } from '../persistence/baselines.ts';

export interface ExecutionApi {
  token: string;
  operator: Operator;
  queue: RunQueue;
  baselines: Baselines;
  artifacts: ArtifactStore;
}

const uuid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$',
};
const projectParams = {
  type: 'object',
  properties: { projectId: uuid },
  required: ['projectId'],
};
const runParams = {
  type: 'object',
  properties: { projectId: uuid, runId: uuid },
  required: ['projectId', 'runId'],
};
const jobParams = {
  type: 'object',
  properties: { ...runParams.properties, jobId: uuid },
  required: [...runParams.required, 'jobId'],
};
const kinds = ['current', 'baseline', 'diff', 'heatmap', 'overlay'];
type Project = { projectId: string };
type Run = Project & { runId: string };
type Job = Run & { jobId: string };

function hash(token: string) {
  return createHash('sha256').update(token).digest();
}

function sendPng(reply: FastifyReply, png: Buffer) {
  return reply
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .type('image/png')
    .send(png);
}

export function registerExecutionApi(app: FastifyInstance, api: ExecutionApi) {
  const expected = hash(api.token);
  app.addHook('onRequest', async (request, reply) => {
    const authorization = request.headers.authorization;
    if (
      !authorization ||
      !/^Bearer \S+$/i.test(authorization) ||
      !timingSafeEqual(hash(authorization.slice(7)), expected)
    ) {
      return reply
        .code(401)
        .send({ error: 'A valid local operator token is required' });
    }
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ExecutionError)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof BaselineError) {
      const codes = {
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        invalid_capture: 400,
      };
      return reply.code(codes[error.code]).send({ error: error.message });
    }
    if (error instanceof ArtifactError)
      return reply.code(503).send({ error: 'Evidence storage is unavailable' });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({ error: 'Invalid request' });
    }
    request.log.error(
      { event: 'execution_api_error' },
      'Execution API request failed',
    );
    return reply.code(503).send({ error: 'Execution service is unavailable' });
  });

  const { queue, baselines, artifacts, operator } = api;
  const scope = (projectId: string) => ({ ...operator, projectId });
  const getJobResult = async ({
    projectId,
    runId,
    jobId,
  }: Job): Promise<JobResult> => {
    const run = await queue.detail(scope(projectId), runId);
    const job = run.jobs.find(({ id }) => id === jobId);
    if (!job) throw new ExecutionError(404, 'Checkpoint result was not found');
    if (!job.result)
      throw new ExecutionError(409, 'Checkpoint has no completed result');
    return job.result;
  };

  app.get('/projects', () => queue.projects(operator));
  app.post<{ Body: { name: string } }>(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              pattern: '\\S',
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await queue.createProject(operator, request.body.name.trim())),
  );

  app.get<{ Params: Project }>(
    '/projects/:projectId/suite',
    { schema: { params: projectParams } },
    async (request, reply) => {
      const suite = await queue.latestSuite(scope(request.params.projectId));
      return reply.send({ suite });
    },
  );
  app.put<{ Params: Project; Body: { checkpoints: Checkpoint[] } }>(
    '/projects/:projectId/suite',
    {
      schema: {
        params: projectParams,
        body: {
          type: 'object',
          required: ['checkpoints'],
          additionalProperties: false,
          properties: {
            checkpoints: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                required: ['key', 'width', 'height'],
                additionalProperties: false,
                properties: {
                  key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
                  width: { type: 'integer', minimum: 100, maximum: 3000 },
                  height: { type: 'integer', minimum: 100, maximum: 3000 },
                  selector: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 300,
                    pattern: '\\S',
                  },
                  masks: {
                    type: 'array',
                    maxItems: 20,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      pattern: '\\S',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await queue.createSuite(
            scope(request.params.projectId),
            request.body.checkpoints,
          ),
        ),
  );

  app.post<{
    Params: Project;
    Body: { suiteId: string; variant?: FixtureVariant; commitSha?: string };
  }>(
    '/projects/:projectId/runs',
    {
      schema: {
        params: projectParams,
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              pattern: '^[a-zA-Z0-9_-]{1,100}$',
            },
          },
        },
        body: {
          type: 'object',
          required: ['suiteId'],
          additionalProperties: false,
          properties: {
            suiteId: uuid,
            variant: { type: 'string', enum: [...fixtureVariants] },
            commitSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const run = await queue.submit(
        scope(request.params.projectId),
        request.headers['idempotency-key'] as string,
        { ...request.body, variant: request.body.variant ?? 'original' },
      );
      return reply.code(202).send(run);
    },
  );
  app.get<{
    Params: Project;
    Querystring: { limit?: number; before?: string };
  }>(
    '/projects/:projectId/runs',
    {
      schema: {
        params: projectParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            before: uuid,
          },
        },
      },
    },
    (request) =>
      queue.list(
        scope(request.params.projectId),
        request.query.limit ?? 20,
        request.query.before,
      ),
  );
  app.get<{ Params: Run }>(
    '/projects/:projectId/runs/:runId',
    { schema: { params: runParams } },
    (request) =>
      queue.detail(scope(request.params.projectId), request.params.runId),
  );
  app.post<{ Params: Run }>(
    '/projects/:projectId/runs/:runId/cancel',
    { schema: { params: runParams } },
    (request) =>
      queue.cancel(scope(request.params.projectId), request.params.runId),
  );

  app.get<{ Params: Job & { kind: Evidence } }>(
    '/projects/:projectId/runs/:runId/jobs/:jobId/evidence/:kind',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            ...jobParams.properties,
            kind: { type: 'string', enum: kinds },
          },
          required: [...jobParams.required, 'kind'],
        },
      },
    },
    async (request, reply) => {
      const result = await getJobResult(request.params);
      const ref = result.evidence[request.params.kind];
      if (!ref) throw new ExecutionError(404, 'This evidence is unavailable');
      return sendPng(reply, await artifacts.get(operator.organizationId, ref));
    },
  );
  app.post<{ Params: Job }>(
    '/projects/:projectId/runs/:runId/jobs/:jobId/candidate',
    { schema: { params: jobParams } },
    async (request) => {
      const result = await getJobResult(request.params);
      if (!result.evidence.current)
        throw new ExecutionError(404, 'Current capture is unavailable');
      return baselines.createCandidate(
        scope(request.params.projectId),
        result.identity,
        result.comparedBaselineId,
        {
          metadata: result.capture,
          png: await artifacts.get(
            operator.organizationId,
            result.evidence.current,
          ),
        },
        request.params.jobId,
      );
    },
  );
  app.post<{
    Params: Project & { versionId: string };
    Body: {
      action: 'approve' | 'reject' | 'rollback';
      expectedActive?: string | null;
    };
  }>(
    '/projects/:projectId/baselines/:versionId/review',
    {
      schema: {
        params: {
          type: 'object',
          properties: { projectId: uuid, versionId: uuid },
          required: ['projectId', 'versionId'],
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'rollback'] },
            expectedActive: { anyOf: [uuid, { type: 'null' }] },
          },
        },
      },
    },
    (request) =>
      baselines.review(
        scope(request.params.projectId),
        request.params.versionId,
        request.body.action,
        request.body.expectedActive,
      ),
  );
}
