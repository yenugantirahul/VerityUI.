import type { Page } from 'playwright';
import { fixtureData, weeklyFixtureData } from './page.ts';

export interface DashboardCheck {
  id: string;
  passed: boolean;
  message: string;
}

const currency = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
const expected = {
  revenue: currency(fixtureData.revenue),
  sessions: new Intl.NumberFormat('en-US').format(fixtureData.sessions),
  conversion: new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(fixtureData.conversion / 100),
};

export async function inspectDashboard(
  page: Page,
  remainingMs: number,
): Promise<DashboardCheck[]> {
  const checks: DashboardCheck[] = await page.evaluate((expectedValues) => {
    const check = (id: string, passed: boolean, message: string) => ({
      id,
      passed,
      message,
    });
    const visible = (element: Element | null) =>
      Boolean(
        element &&
        element.getClientRects().length &&
        getComputedStyle(element).visibility === 'visible',
      );
    const ready = document.querySelector('main')?.dataset.ready === 'true';
    const result = [
      check(
        'render',
        ready,
        ready
          ? 'Dashboard signaled successful rendering.'
          : 'Dashboard signaled a rendering error.',
      ),
    ];
    if (!ready) return result;

    for (const [key, expectedText] of Object.entries(expectedValues)) {
      const value = document.querySelector(`[data-kpi="${key}"] strong`);
      const actual = value?.textContent?.trim();
      result.push(
        check(
          `kpi_${key}`,
          visible(value) && actual === expectedText,
          `${key} expected ${expectedText}, observed ${visible(value) ? actual : 'a hidden value'}.`,
        ),
      );
    }
    const axis = [...document.querySelectorAll('.axis span')];
    const legend = document.querySelector('.legend');
    result.push(
      check(
        'chart_labels',
        axis.length === 2 && axis.every(visible) && visible(legend),
        'Chart axis labels and the series legend must be visible.',
      ),
    );
    const [first, second] = axis.map((element) =>
      element.getBoundingClientRect(),
    );
    const overlap = Boolean(
      first &&
      second &&
      first.left < second.right &&
      second.left < first.right &&
      first.top < second.bottom &&
      second.top < first.bottom,
    );
    result.push(
      check(
        'chart_overlap',
        !overlap,
        'Chart axis labels must have non-overlapping bounds.',
      ),
    );
    const chart = document.querySelector('.chart')?.getBoundingClientRect();
    const plot = document.querySelector('.plot');
    const bounds = plot?.getBoundingClientRect();
    const plotFits = Boolean(
      chart &&
      plot &&
      bounds &&
      bounds.left >= chart.left &&
      bounds.right <= chart.right + 1 &&
      bounds.top >= chart.top &&
      bounds.bottom <= chart.bottom + 1 &&
      getComputedStyle(plot).clipPath === 'none',
    );
    result.push(
      check(
        'chart_area',
        plotFits,
        'The chart plot must fit inside its panel without clipping.',
      ),
    );
    const table = document.querySelector('table');
    const tableBounds = table?.getBoundingClientRect();
    const tablePanel = table?.closest('.panel')?.getBoundingClientRect();
    result.push(
      check(
        'table_area',
        Boolean(
          tableBounds &&
          tablePanel &&
          tableBounds.right <= tablePanel.right + 1 &&
          tableBounds.left >= tablePanel.left,
        ),
        'The data table must fit inside its panel.',
      ),
    );
    result.push(
      check(
        'viewport',
        document.documentElement.scrollWidth <= innerWidth + 1,
        `Viewport is ${innerWidth} px and document content spans ${document.documentElement.scrollWidth} px.`,
      ),
    );
    return result;
  }, expected);

  if (!checks[0]?.passed) return checks;
  const filter = page.locator('#date-range');
  const wait = Math.max(100, Math.min(1500, Math.floor(remainingMs / 4)));
  const ready = (window: string) =>
    page.locator(`main[data-window="${window}"][data-ready="true"]`);
  let passed: boolean;
  try {
    await filter.selectOption('7d', { timeout: wait });
    await ready('7d').waitFor({ state: 'visible', timeout: wait });
    passed =
      (await page
        .locator('[data-kpi="revenue"] strong')
        .textContent({ timeout: wait })) ===
      currency(weeklyFixtureData.revenue);
  } catch {
    passed = false;
  }
  try {
    await filter.selectOption('30d', { timeout: wait });
    await ready('30d').waitFor({ state: 'visible', timeout: wait });
  } catch {
    passed = false;
  }
  checks.push({
    id: 'date_filter',
    passed,
    message: passed
      ? 'The seven-day filter renders fixture data and restores the default range.'
      : 'The date filter did not render the expected data or restore the default range.',
  });
  return checks;
}
