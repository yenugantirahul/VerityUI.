import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capture } from '../src/capture/engine.ts';
import { desktopProfile } from '../src/capture/policy.ts';
import { compareScreenshots } from '../src/compare/compare.ts';
import {
  inspectDashboard,
  type DashboardCheck,
} from '../src/fixture/assertions.ts';
import type { FixtureVariant } from '../src/fixture/page.ts';
import { startFixture } from '../src/fixture/server.ts';

test(
  'rendered analytics assertions detect data, layout and interaction defects independently',
  { timeout: 50000 },
  async (context) => {
    const fixture = await startFixture();
    context.after(() => fixture.close());
    const target = { path: '/analytics', readySelector: 'main[data-ready]' };
    async function inspect(variant: FixtureVariant, mobile = false) {
      fixture.selectVariant(variant);
      let checks: DashboardCheck[] = [];
      const screenshot = await capture(
        {
          origin: fixture.origin,
          profile: mobile
            ? { ...desktopProfile, viewport: { width: 390, height: 720 } }
            : desktopProfile,
          target,
        },
        async (page, timeoutMs) => {
          checks = await inspectDashboard(page, timeoutMs);
        },
      );
      return {
        screenshot,
        checks,
        failures: checks.filter((check) => !check.passed).map(({ id }) => id),
      };
    }
    const original = await inspect('original');
    assert.equal(original.checks.length, 10);
    assert.deepEqual(original.failures, []);
    assert.deepEqual((await inspect('original', true)).failures, []);
    const failures: [FixtureVariant, string][] = [
      ['wrong_value', 'kpi_revenue'],
      ['missing', 'kpi_sessions'],
      ['missing_legend', 'chart_labels'],
      ['overlapping_labels', 'chart_overlap'],
      ['clipped', 'chart_area'],
      ['overflow', 'chart_area'],
      ['filter_broken', 'date_filter'],
      ['render_error', 'render'],
      ['table_overflow', 'table_area'],
      ['responsive', 'viewport'],
    ];
    for (const [variant, check] of failures) {
      const actual = await inspect(variant, variant === 'responsive');
      assert.ok(
        actual.failures.includes(check),
        `${variant} reported ${actual.failures.join(', ')}`,
      );
      if (variant === 'filter_broken') {
        assert.equal(
          compareScreenshots(original.screenshot.png, actual.screenshot.png)
            .summary.status,
          'matched',
        );
      }
    }
  },
);
