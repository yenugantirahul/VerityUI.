import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture } from '../capture/engine.ts';
import { desktopProfile } from '../capture/policy.ts';
import { startFixture } from './server.ts';

const fixture = await startFixture();
const directory = resolve('data', 'demo');
try {
  await mkdir(directory, { recursive: true });
  const result = await capture({
    origin: fixture.origin,
    profile: desktopProfile,
    target: { path: '/analytics', readySelector: 'main[data-ready="true"]' },
  });
  await writeFile(resolve(directory, 'analytics.png'), result.png);
  await writeFile(
    resolve(directory, 'analytics.json'),
    JSON.stringify(result.metadata, null, 2),
  );
  process.stdout.write(`${resolve(directory, 'analytics.png')}\n`);
} finally {
  await fixture.close();
}
