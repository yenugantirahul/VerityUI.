import Fastify from 'fastify';
import {
  analyticsPage,
  fixtureData,
  weeklyFixtureData,
  fixtureVariants,
  type FixtureVariant,
} from './page.ts';

export async function startFixture(
  initialVariant: FixtureVariant = 'original',
) {
  if (!fixtureVariants.includes(initialVariant))
    throw new Error('Unknown analytics fixture variant');
  const app = Fastify({ bodyLimit: 4096 });
  let variant = initialVariant;
  let refreshes = 0;
  let metricsRequests = 0;

  app.get<{ Querystring: { dynamic?: string } }>(
    '/analytics',
    (request, reply) => {
      reply.type('text/html; charset=utf-8');
      return analyticsPage(
        variant,
        request.query.dynamic === '1' ? ++refreshes : 0,
      );
    },
  );
  app.get('/private', (request, reply) => {
    if (
      !request.headers.cookie
        ?.split(/;\s*/)
        .includes('fixture_session=fixture-test')
    ) {
      return reply.code(401).send({ error: 'fixture session required' });
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(analyticsPage(variant, 0));
  });
  app.get<{ Querystring: { window?: string } }>(
    '/fixture/metrics',
    (request) => {
      metricsRequests++;
      return request.query.window === '7d' ? weeklyFixtureData : fixtureData;
    },
  );
  app.get('/redirect', (_request, reply) => reply.redirect('/analytics'));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    origin,
    metricsRequests: () => metricsRequests,
    selectVariant(value: FixtureVariant) {
      if (!fixtureVariants.includes(value))
        throw new Error('Unknown analytics fixture variant');
      variant = value;
    },
    close: () => app.close(),
  };
}
