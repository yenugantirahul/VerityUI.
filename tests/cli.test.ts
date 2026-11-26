import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

test(
  'compiled CLI enforces reference and analytics policies and writes evidence',
  { timeout: 75000 },
  async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), 'deltaframe-cli-'));
    context.after(() =>
      rm(workspace, { recursive: true, force: true, maxRetries: 3 }),
    );
    type Report = {
      status: string;
      commit: string;
      results: {
        comparison?: { status: string };
        evidence: string[];
        checks: { id: string; passed: boolean }[];
      }[];
    };
    const reference = join(workspace, 'reference');
    const commit = 'a'.repeat(40);
    async function command(args: string[], expected: number) {
      let code = 0;
      let output: string;
      try {
        output = (
          await run(process.execPath, ['dist/cli/main.js', ...args], {
            timeout: 25000,
          })
        ).stdout;
      } catch (error) {
        const rejected = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        code = Number(rejected.code);
        output = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`;
      }
      assert.equal(code, expected, output);
      return output;
    }
    async function compare(
      folder: string,
      variant: string,
      expected: number,
      base = reference,
    ) {
      const output = join(workspace, folder);
      await command(
        [
          'run',
          '--reference',
          base,
          '--output',
          output,
          '--variant',
          variant,
          '--commit',
          commit,
        ],
        expected,
      );
      return JSON.parse(
        await readFile(join(output, 'report.json'), 'utf8'),
      ) as Report;
    }

    await command(['capture', '--output', reference, '--commit', commit], 0);
    const baseline = JSON.parse(
      await readFile(join(reference, 'reference.json'), 'utf8'),
    );
    assert.equal(baseline.commit, commit);
    assert.equal(baseline.captures.length, 2);
    assert.equal((await compare('matching', 'original', 0)).status, 'passed');

    const changed = await compare('changed', 'color', 1);
    assert.equal(changed.status, 'failed');
    assert.equal(changed.commit, commit);
    assert.ok(
      changed.results.every((value) => value.comparison?.status === 'changed'),
    );
    const diff = changed.results[0]!.evidence.find((file) =>
      file.endsWith('-diff.png'),
    );
    assert.ok(diff);
    assert.equal(
      (await readFile(join(workspace, 'changed', diff))).toString(
        'ascii',
        1,
        4,
      ),
      'PNG',
    );

    const badFilter = await compare('bad-filter', 'filter_broken', 1);
    assert.ok(
      badFilter.results.every(
        (value) => value.comparison?.status === 'matched',
      ),
    );
    assert.ok(
      badFilter.results.every((value) =>
        value.checks.some(
          (check) => check.id === 'date_filter' && !check.passed,
        ),
      ),
    );
    assert.equal(
      (
        await compare(
          'needs-review',
          'original',
          2,
          join(workspace, 'unavailable'),
        )
      ).status,
      'review_required',
    );

    await writeFile(
      join(reference, 'desktop.png'),
      'test-only changed artifact',
    );
    const integrity = await command(
      [
        'run',
        '--reference',
        reference,
        '--output',
        join(workspace, 'integrity'),
      ],
      3,
    );
    assert.match(integrity, /Reference integrity check failed/);
  },
);
