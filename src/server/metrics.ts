import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const bounds = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function registerMetrics(app: FastifyInstance, token: string) {
  const expected = createHash('sha256').update(token).digest();
  const counts = new Map<string, number>();
  const times = bounds.map(() => 0);
  let total = 0;
  let seconds = 0;
  app.addHook('onResponse', async (request, reply) => {
    if (
      ['/metrics', '/healthz', '/readyz'].includes(
        request.routeOptions.url ?? '',
      )
    )
      return;
    const outcome = `${Math.floor(reply.statusCode / 100)}xx`;
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    const elapsed = reply.elapsedTime / 1000;
    total++;
    seconds += elapsed;
    for (const [index, limit] of bounds.entries())
      if (elapsed <= limit) times[index]!++;
  });
  app.get('/metrics', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth =
      /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!timingSafeEqual(expected, createHash('sha256').update(auth).digest()))
      return reply.code(401).send({ error: 'Metrics authentication required' });
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(
        [
          '# TYPE verityui_http_requests_total counter',
          ...[...counts].map(
            ([outcome, count]) =>
              `verityui_http_requests_total{outcome="${outcome}"} ${count}`,
          ),
          '# TYPE verityui_http_request_duration_seconds histogram',
          ...bounds.map(
            (bound, index) =>
              `verityui_http_request_duration_seconds_bucket{le="${bound}"} ${times[index]}`,
          ),
          `verityui_http_request_duration_seconds_bucket{le="+Inf"} ${total}`,
          `verityui_http_request_duration_seconds_sum ${seconds}`,
          `verityui_http_request_duration_seconds_count ${total}`,
          '',
        ].join('\n'),
      );
  });
}
