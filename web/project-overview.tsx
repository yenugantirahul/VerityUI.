import type { RunQueue } from '../src/execution/queue.ts';

export type ProjectMetrics = Awaited<ReturnType<RunQueue['metrics']>>;

function elapsed(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function ProjectOverview({
  metrics,
}: {
  metrics: ProjectMetrics | null;
}) {
  const terminal = (metrics?.completed ?? 0) + (metrics?.failed ?? 0);
  const completion = terminal
    ? Math.round((metrics!.completed / terminal) * 100)
    : null;
  const values = [
    {
      name: 'Runs',
      value: metrics?.runs,
      detail: metrics
        ? `${metrics.checkpoints} checkpoints`
        : 'All capture sources',
      tone: 'neutral',
    },
    {
      name: 'Needs review',
      value: metrics?.review_required,
      detail: 'Unresolved checkpoints',
      tone: metrics?.review_required ? 'attention' : 'neutral',
    },
    {
      name: 'Completion rate',
      value: completion === null ? null : `${completion}%`,
      detail: terminal
        ? `${metrics!.completed} of ${terminal} processed`
        : 'Awaiting completed checks',
      tone: 'success',
    },
    {
      name: 'P95 turnaround',
      value: metrics?.p95_ms == null ? null : elapsed(metrics.p95_ms),
      detail:
        metrics?.p95_queue_ms != null
          ? `Queue P95 ${elapsed(metrics.p95_queue_ms)}`
          : 'From queued to compared',
      tone: 'neutral',
    },
  ];
  return (
    <section className="overview" aria-label="Project quality metrics">
      <div className="overview-heading">
        <h2>Project overview</h2>
        <span>Last 7 days</span>
      </div>
      <dl className="quality-grid">
        {values.map(({ name, value, detail, tone }) => (
          <div className={`quality-card tone-${tone}`} key={name}>
            <dt>{name}</dt>
            <dd>{value ?? '—'}</dd>
            <dd className="quality-detail">{detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
