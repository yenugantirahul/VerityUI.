import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { Report } from '../src/cli/report.ts';
import { createVisionAnalyzer } from '../src/verification/vision.ts';

const run = promisify(execFile);

test(
  'verifies a real application, retains only selected metadata and evaluates scoped intent',
  { timeout: 60_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'verityui-app-'));
    context.after(() =>
      rm(directory, { recursive: true, force: true, maxRetries: 3 }),
    );

    async function startApp(initial: string) {
      let color = initial;
      const server = createServer((request, response) => {
        if (request.url !== '/checkout') return response.writeHead(404).end();
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<!doctype html><main><h1>Checkout</h1>
      <button data-testid="pay" data-verity-component="CheckoutButton" data-verity-source="src/Checkout.tsx:15"
        style="background-color:${color};height:48px;width:140px">Place order</button>
      <p class="customer" style="width:160px;height:30px">PRIVATE_ACCOUNT_235</p>
      <span id="nonce"></span></main>
      <script>document.getElementById('nonce').textContent = Math.random();</script>`);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      context.after(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return {
        origin: `http://127.0.0.1:${address.port}`,
        switchColor: (value: string) => {
          color = value;
        },
      };
    }

    const base = await startApp('white');
    const head = await startApp('white');
    const config = join(directory, 'verityui.config.json');
    const intent = join(directory, 'intent.yaml');
    const options = {
      version: 2,
      baseURL: base.origin,
      routes: [
        { path: '/checkout', readySelector: 'main', masks: ['.customer'] },
      ],
      viewports: [{ width: 390, height: 844 }],
      capture: { randomSeed: 42 },
      verification: { mode: 'strict', intent: 'intent.yaml' },
    };
    async function command(args: string[], expected: number) {
      try {
        await run(
          process.execPath,
          ['dist/cli/main.js', ...args, '--config', config],
          { timeout: 20_000 },
        );
        assert.equal(expected, 0, args.join(' '));
      } catch (error) {
        const result = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        assert.equal(
          result.code,
          expected,
          `${result.stdout ?? ''}${result.stderr ?? ''}`,
        );
      }
    }
    await command(['init', '--base-url', base.origin], 0);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).version, 2);
    await writeFile(config, JSON.stringify(options));
    await writeFile(
      intent,
      `intent:
  description: Update the checkout button
  allowedChanges:
    - component: CheckoutButton
      properties: [background-color]
`,
    );
    const reference = join(directory, 'base');
    const candidate = join(directory, 'head');
    await command(['capture', '--output', reference], 0);

    async function verify(name: string, expected: number, offline = false) {
      const output = join(directory, name);
      await command(
        [
          ...(offline
            ? ['compare', '--current', candidate]
            : ['verify', '--base-url', head.origin]),
          '--reference',
          reference,
          '--output',
          output,
        ],
        expected,
      );
      return {
        output,
        report: JSON.parse(
          await readFile(join(output, 'report.json'), 'utf8'),
        ) as Report,
      };
    }
    const unchanged = await verify('unchanged', 0);
    assert.equal(unchanged.report.results[0]?.intent?.verdict, 'unchanged');
    head.switchColor('rebeccapurple');
    await command(
      ['capture', '--base-url', head.origin, '--output', candidate],
      0,
    );
    const expected = await verify('expected', 2, true);
    const finding = expected.report.results[0]!;
    assert.equal(finding.intent?.verdict, 'within_intent');
    assert.deepEqual(finding.structure?.changes[0]?.properties, [
      {
        name: 'background-color',
        before: 'rgb(255, 255, 255)',
        after: 'rgb(102, 51, 153)',
      },
    ]);
    assert.equal(finding.structure?.changes[0]?.source, 'src/Checkout.tsx:15');
    assert.ok(
      finding.evidence.some((name) => name.endsWith('region-1-current.png')),
    );
    const snapshot = await readFile(
      join(
        expected.output,
        finding.evidence.find((name) => name.endsWith('-dom.json'))!,
      ),
      'utf8',
    );
    assert.doesNotMatch(snapshot, /PRIVATE_ACCOUNT|Place order|customer/);
    assert.match(
      await readFile(join(expected.output, 'report.html'), 'utf8'),
      /CheckoutButton/,
    );

    await writeFile(
      config,
      JSON.stringify({ ...options, criticalRoutes: ['/checkout'] }),
    );
    const critical = await verify('protected', 1, true);
    assert.equal(critical.report.results[0]?.intent?.verdict, 'needs_review');
    assert.equal(critical.report.status, 'failed');

    await writeFile(
      config,
      JSON.stringify({ ...options, routes: ['/invalid'] }),
    );
    const broken = await verify('broken', 3);
    assert.equal(broken.report.status, 'inconclusive');
    assert.match(
      broken.report.results.find(({ route }) => route === '/invalid')
        ?.failure ?? '',
      /404|navigation/,
    );
    assert.match(
      broken.report.results.find(({ route }) => route === '/checkout')
        ?.failure ?? '',
      /absent from the current configuration/,
    );
  },
);

test('validates model evidence and handles unavailable providers', async () => {
  const environment = {
    VERITYUI_VISION_ENDPOINT: 'https://vision.example.test/v1/chat/completions',
    VERITYUI_VISION_KEY: 'example',
    VERITYUI_VISION_MODEL: 'test-model',
  };
  const input = {
    route: '/checkout',
    critical: true,
    intent: undefined,
    structure: undefined,
    crops: [
      {
        id: 'region-1',
        baseline: Buffer.from('base'),
        current: Buffer.from('head'),
      },
    ],
  };
  const result = {
    verdict: 'regression',
    confidence: 0.8,
    severity: 'high',
    explanation: 'The contrast changed.',
    evidenceIds: ['region-1'],
    affectedElements: [],
    suspectedSourceFiles: [],
    matchesIntent: null,
    suggestedFix: null,
  };
  const provider = (body: unknown) => async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(body) } }],
    });
  assert.equal(
    (await createVisionAnalyzer(environment, provider(result))(input)).status,
    'classified',
  );
  assert.deepEqual(
    await createVisionAnalyzer(
      environment,
      provider({ ...result, suspectedSourceFiles: ['invented.tsx'] }),
    )(input),
    { status: 'unavailable', reason: 'invalid_response' },
  );
  assert.deepEqual(await createVisionAnalyzer({}, provider(result))(input), {
    status: 'unavailable',
    reason: 'configuration',
  });
});
