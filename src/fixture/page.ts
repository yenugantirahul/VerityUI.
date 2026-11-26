export const fixtureVersion = '2';
export const fixtureVariants = [
  'original',
  'color',
  'missing',
  'shift',
  'overflow',
  'clipped',
  'typography',
  'wrong_value',
  'missing_legend',
  'overlapping_labels',
  'filter_broken',
  'render_error',
  'table_overflow',
  'responsive',
  'cosmetic',
  'loading',
  'tall',
] as const;
export type FixtureVariant = (typeof fixtureVariants)[number];

export const fixtureData = {
  revenue: 48240,
  sessions: 28316,
  conversion: 3.8,
  values: [28, 44, 38, 61, 49, 73, 65, 82, 70, 89, 77, 96],
};
export const weeklyFixtureData = {
  revenue: 10980,
  sessions: 6801,
  conversion: 4.2,
  values: [31, 54, 47, 58, 79, 83, 94],
};

export function analyticsPage(
  variant: FixtureVariant,
  dynamic: number,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbor Analytics</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: #20293e; background: #f3f6fa; font: 16px/1.5 Arial, sans-serif; }
  header { background: #15243b; color: #fff; padding: 15px max(24px, calc((100% - 1120px) / 2)); font-weight: 700; }
  main { max-width: 1168px; margin: auto; padding: 28px 24px 20px; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 31px; line-height: 1.2; }
  h2 { font-size: 18px; }
  .muted { color: #4b5b72; }
  .summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; }
  .summary-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .summary-actions label { display: flex; align-items: center; gap: 7px; font-size: 14px; }
  .summary-actions select { font: inherit; padding: 5px 7px; color: #223a57; background: #fff; border: 1px solid #c2d1e3; border-radius: 5px; }
  .dynamic { display: inline-block; width: 112px; height: 28px; text-align: right; font-variant-numeric: tabular-nums; }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 20px 0 16px; }
  .panel { background: #fff; border: 1px solid #dde5ef; padding: 17px; border-radius: 12px; }
  .kpi strong { display: block; font-size: 25px; }
  .chart { margin-bottom: 15px; }
  .plot { display: flex; gap: 7px; height: 180px; align-items: flex-end; padding: 9px 9px 0; margin-top: 13px; background: repeating-linear-gradient(to top, #e8eef7 0 1px, transparent 1px 42px); }
  .bar { flex: 1; min-width: 0; background: #2466cf; border-radius: 4px 4px 0 0; }
  .bar:nth-child(even) { background: #5799e1; }
  .bar:last-child { background: #158068; }
  .axis { display: flex; justify-content: space-between; margin-top: 7px; font-size: 14px; }
  .legend { display: flex; align-items: center; gap: 5px; margin-top: 5px; font-size: 14px; }
  .legend i { background: #2466cf; width: 10px; height: 10px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 8px; }
  th, td { padding: 5px 0; border-bottom: 1px solid #e8eef7; }
  td:last-child, th:last-child { text-align: right; }
  .color .bar { background: #b43d61; }
  .missing [data-kpi="sessions"] { visibility: hidden; }
  .shift .chart { transform: translateX(18px); }
  .overflow .plot { width: calc(100% + 90px); }
  .clipped .plot { clip-path: inset(35% 0 0 0); }
  .missing_legend .legend { visibility: hidden; }
  .overlapping_labels .axis { position: relative; }
  .overlapping_labels .axis span:last-child { position: absolute; left: 0; }
  .table_overflow table { width: calc(100% + 160px); }
  .typography .kpi strong { font-size: 20px; line-height: 37.5px; font-weight: 400; }
  .cosmetic .chart h2 { color: #212a3f; }
  .tall main { min-height: 150000px; }
  @media (max-width: 560px) {
    .responsive main { min-width: 660px; }
    main { padding: 22px 14px 14px; }
    header { padding-inline: 14px; }
    .kpis { grid-template-columns: minmax(0,1fr); gap: 8px; }
    .panel { padding: 12px; }
    .plot { height: 150px; gap: 4px; }
  }
</style>
</head>
<body class="${variant}">
<header>Harbor Analytics</header>
<main>
  <section class="summary" aria-label="Report summary">
    <div><h1>Commerce overview</h1><p class="muted">Report date <time id="report-date"></time></p></div>
    <div class="summary-actions"><label>Date range <select id="date-range"><option value="30d">Last 30 days</option><option value="7d">Last 7 days</option></select></label>
    <span class="dynamic muted" aria-label="Refresh identifier">${dynamic ? `Refresh ${dynamic}` : 'Refresh 0'}</span></div>
  </section>
  <section class="kpis" aria-label="Key metrics">
    <article class="panel kpi" data-kpi="revenue">Revenue<strong></strong></article>
    <article class="panel kpi" data-kpi="sessions">Sessions<strong></strong></article>
    <article class="panel kpi" data-kpi="conversion">Conversion<strong></strong></article>
  </section>
  <section class="panel chart" data-verity-component="RevenueChart" data-testid="revenue-chart" aria-labelledby="chart-title">
    <h2 id="chart-title">Revenue trend</h2><div class="plot" data-verity-component="RevenuePlot" data-testid="revenue-plot" aria-hidden="true"></div>
    <div class="axis muted" aria-label="Chart axis"><span>Jan</span><span>Dec</span></div>
    <div class="legend muted" aria-label="Chart legend"><i aria-hidden="true"></i>Revenue</div>
  </section>
  <section class="panel" aria-labelledby="table-title">
    <h2 id="table-title">Top channels</h2>
    <table><thead><tr><th>Channel</th><th>Sessions</th></tr></thead>
    <tbody><tr><td>Organic search</td><td>12,436</td></tr><tr><td>Direct</td><td>8,409</td></tr><tr><td>Referral</td><td>7,471</td></tr></tbody></table>
  </section>
</main>
<script>
  const date = new Date();
  document.querySelector('#report-date').textContent = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'}).format(date);
  const main = document.querySelector('main');
  const select = document.querySelector('#date-range');
  async function render(window) {
    delete main.dataset.ready;
    if (document.body.classList.contains('render_error')) throw new Error('Seeded render failure');
    const response = await fetch(window === '7d' ? '/fixture/metrics?window=7d' : '/fixture/metrics');
    if (!response.ok) throw new Error('Fixture request failed');
    const data = await response.json();
    const setKpi = (kpi, value) => document.querySelector('[data-kpi="' + kpi + '"] strong').textContent = value;
    const revenue = document.body.classList.contains('wrong_value') ? data.revenue + 1000 : data.revenue;
    setKpi('revenue', new Intl.NumberFormat(undefined, {style:'currency', currency:'USD', maximumFractionDigits:0}).format(revenue));
    setKpi('sessions', new Intl.NumberFormat().format(data.sessions));
    setKpi('conversion', new Intl.NumberFormat(undefined, {style:'percent', maximumFractionDigits:1}).format(data.conversion / 100));
    const plot = document.querySelector('.plot');
    plot.replaceChildren();
    for (const height of data.values) {
      const element = document.createElement('div');
      element.className = 'bar';
      element.style.height = height + '%';
      plot.appendChild(element);
    }
    main.dataset.window = window;
    if (!document.body.classList.contains('loading')) main.dataset.ready = 'true';
  }
  const update = () => { void render(select.value).catch(() => { main.dataset.ready = 'error'; }); };
  select.addEventListener('change', () => {
    if (!document.body.classList.contains('filter_broken')) update();
  });
  update();
</script>
</body></html>`;
}
