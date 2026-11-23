import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, parsePort } from '../src/server/app.ts';

test('loopback service exposes the documented health response', async (context) => {
  const app = createApp();
  context.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await fetch(`${address}/unknown`)).status, 404);
});

test('port configuration fails closed for invalid values', () => {
  assert.equal(parsePort(undefined), 4310);
  assert.equal(parsePort('65535'), 65535);
  for (const value of ['', '0', '65536', '1.5', '1e3', ' 4310', 'temp']) {
    assert.throws(() => parsePort(value), /PORT must be an integer/);
  }
});
