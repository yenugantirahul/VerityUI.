import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Checkpoint, Evidence, RunQueue } from '../src/execution/queue.ts';
import './style.css';

type WorkspaceEntry = { id: string; name: string };
type Session = { workspace: WorkspaceEntry; workspaces: WorkspaceEntry[] };
type Project = { id: string; name: string };
type Suite = { id: string; checkpoints: Checkpoint[] };
type Run = Awaited<ReturnType<RunQueue['list']>>[number];
type Detail = Awaited<ReturnType<RunQueue['detail']>>;
type Candidate = {
  id: string;
  version: number;
  status: 'candidate' | 'approved' | 'rejected';
};

const variants = {
  original: 'Original fixture',
  color: 'Chart recolor',
  missing: 'Missing KPI',
  shift: 'Shifted chart',
  overflow: 'Chart overflow',
  clipped: 'Clipped plot',
  typography: 'Typography change',
  cosmetic: 'Subtle text tint',
  loading: 'Readiness timeout',
  tall: 'Oversized page',
};
const initialCheckpoints: Checkpoint[] = [
  { key: 'desktop', width: 1200, height: 800 },
];
const apiRoot = '/api/v1';
function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const result = await fetch(`${apiRoot}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (result.status === 204) return undefined as T;
  const payload = await result.json().catch(() => ({}));
  if (!result.ok)
    throw new Error(payload.error ?? 'The local API is unavailable');
  return payload as T;
}

function Brand() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <i />
        <i />
      </span>
      Deltaframe
    </div>
  );
}

function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    missing: 'Needs baseline',
    incompatible: 'Dimensions changed',
    changed: 'Visual change',
    matched: 'Matched',
    completed: 'Complete',
    running: 'Running',
    queued: 'Queued',
    failed: 'Failed',
    cancelled: 'Cancelled',
    approved: 'Approved',
    rejected: 'Rejected',
    candidate: 'Review pending',
  };
  return (
    <span className={`status status-${value}`}>{labels[value] ?? value}</span>
  );
}

function runStatus(states: string[]) {
  if (states.includes('running')) return 'running';
  if (states.includes('queued')) return 'queued';
  if (states.includes('failed')) return 'failed';
  if (states.includes('cancelled')) return 'cancelled';
  return 'completed';
}

function SuiteEditor({
  suite,
  save,
}: {
  suite: Suite | null;
  save: (checks: Checkpoint[]) => Promise<void>;
}) {
  const [checks, setChecks] = useState(
    suite?.checkpoints ?? initialCheckpoints,
  );
  const [saving, setSaving] = useState(false);
  const update = (index: number, change: Partial<Checkpoint>) =>
    setChecks((current) =>
      current.map((item, position) =>
        position === index ? { ...item, ...change } : item,
      ),
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await save(checks);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="panel suite" onSubmit={submit}>
      <div className="panel-heading">
        <h2>Test suite</h2>
        <button
          type="button"
          className="secondary"
          disabled={checks.length >= 6}
          onClick={() =>
            setChecks([
              ...checks,
              {
                key: `checkpoint-${checks.length + 1}`,
                width: 390,
                height: 720,
              },
            ])
          }
        >
          Add checkpoint
        </button>
      </div>
      {checks.map((check, index) => (
        <fieldset key={index}>
          <legend>Checkpoint {index + 1}</legend>
          <label>
            Key
            <input
              value={check.key}
              pattern="[a-zA-Z0-9_\-]+"
              required
              maxLength={80}
              onChange={(event) => update(index, { key: event.target.value })}
            />
          </label>
          <label>
            Width
            <input
              type="number"
              min="100"
              max="3000"
              value={check.width}
              onChange={(event) =>
                update(index, { width: Number(event.target.value) })
              }
              required
            />
          </label>
          <label>
            Height
            <input
              type="number"
              min="100"
              max="3000"
              value={check.height}
              onChange={(event) =>
                update(index, { height: Number(event.target.value) })
              }
              required
            />
          </label>
          <label>
            Component selector
            <input
              placeholder="Full page"
              maxLength={300}
              value={check.selector ?? ''}
              onChange={(event) =>
                update(index, { selector: event.target.value || undefined })
              }
            />
          </label>
          <label className="wide">
            Mask selectors, one per line
            <textarea
              defaultValue={check.masks?.join('\n') ?? ''}
              onBlur={(event) =>
                update(index, {
                  masks: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          {checks.length > 1 && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setChecks(checks.filter((_, position) => position !== index))
              }
            >
              Remove checkpoint
            </button>
          )}
        </fieldset>
      ))}
      <button className="primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save suite'}
      </button>
    </form>
  );
}

function Review({
  projectId,
  run,
  report,
}: {
  projectId: string;
  run: Detail;
  report: (message: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Evidence | 'slider'>('current');
  const [split, setSplit] = useState(50);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [working, setWorking] = useState(false);
  const job = run.jobs[index];
  const result = job?.result;
  const summary = result?.comparison;
  const path = `/projects/${projectId}/runs/${run.id}/jobs/${job?.id}`;
  useEffect(() => {
    if (!result) return;
    let live = true;
    api<{ candidate: Candidate | null }>(`${path}/candidate`)
      .then((data) => {
        if (live) setCandidate(data.candidate);
      })
      .catch((error: unknown) => {
        if (live) report(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [path, Boolean(result), report]);

  async function decide(action: 'approve' | 'reject') {
    setWorking(true);
    try {
      const next =
        candidate ?? (await api<Candidate>(`${path}/candidate`, 'POST'));
      setCandidate(
        await api<Candidate>(
          `/projects/${projectId}/baselines/${next.id}/review`,
          'POST',
          { action },
        ),
      );
    } catch (error) {
      report(errorText(error));
    } finally {
      setWorking(false);
    }
  }

  const buttons: { key: Evidence | 'slider'; text: string }[] = [
    { key: 'current', text: 'Current' },
    { key: 'baseline', text: 'Baseline' },
    { key: 'diff', text: 'Diff' },
    { key: 'heatmap', text: 'Heatmap' },
    { key: 'overlay', text: 'Overlay' },
    { key: 'slider', text: 'Compare' },
  ];
  const available = buttons.filter(({ key }) =>
    key === 'slider'
      ? result?.evidence.baseline && summary?.status !== 'incompatible'
      : result?.evidence[key],
  );
  const view = available.find(({ key }) => key === mode) ?? available[0];
  const image = (kind: Evidence) => `${apiRoot}${path}/evidence/${kind}`;

  return (
    <section className="panel review" aria-label="Run details">
      <div className="panel-heading">
        <div>
          <h2>{variants[run.variant]}</h2>
          <p className="muted">Run {run.id.slice(0, 8)}</p>
        </div>
        <Status value={runStatus(run.jobs.map((item) => item.state))} />
      </div>
      <div className="checkpoints" aria-label="Checkpoints">
        {run.jobs.map((item, position) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={position === index}
            disabled={working}
            onClick={() => {
              if (position === index) return;
              setIndex(position);
              setMode('current');
              setCandidate(null);
            }}
          >
            <span>{item.checkpoint.key}</span>
            <Status value={item.result?.comparison.status ?? item.state} />
          </button>
        ))}
      </div>
      {!result && (
        <div className="empty" aria-live="polite">
          {job?.state === 'failed'
            ? `Capture failed (${job.failure}) after ${job.attempts} attempts.`
            : job?.state === 'cancelled'
              ? 'This checkpoint was cancelled.'
              : 'Waiting for screenshot evidence…'}
        </div>
      )}
      {result && (
        <div className="review-content">
          <div className="viewer">
            <div className="controls" aria-label="Evidence views">
              {available.map(({ key, text }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={view?.key === key}
                  onClick={() => setMode(key)}
                >
                  {text}
                </button>
              ))}
            </div>
            <div className="image-frame">
              {view?.key === 'slider' ? (
                <div className="wipe">
                  <img alt="Current screenshot" src={image('current')} />
                  <img
                    className="wipe-baseline"
                    alt="Baseline screenshot"
                    src={image('baseline')}
                    style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                  />
                  <span
                    className="wipe-handle"
                    style={{ left: `${split}%` }}
                    aria-hidden="true"
                  />
                </div>
              ) : (
                view && (
                  <img alt={`${view.text} screenshot`} src={image(view.key)} />
                )
              )}
            </div>
            {view?.key === 'slider' && (
              <label className="slider">
                <span>Baseline</span>
                <input
                  type="range"
                  aria-label="Baseline and current split"
                  value={split}
                  min="0"
                  max="100"
                  onChange={(event) => setSplit(Number(event.target.value))}
                />
                <span>Current</span>
              </label>
            )}
          </div>
          <aside className="findings">
            <h3>Comparison</h3>
            <Status value={summary!.status} />
            <p>{summary!.message}</p>
            <dl>
              <div>
                <dt>Capture</dt>
                <dd>
                  {result.capture.width} × {result.capture.height}
                </dd>
              </div>
              <div>
                <dt>Browser</dt>
                <dd>{result.capture.browser}</dd>
              </div>
              <div>
                <dt>Regions</dt>
                <dd>{summary!.regions.length}</dd>
              </div>
            </dl>
            {!!summary!.regions.length && (
              <details>
                <summary>Region bounds</summary>
                <ul>
                  {summary!.regions.map((region) => (
                    <li key={`${region.x}-${region.y}`}>
                      {region.width} × {region.height} at ({region.x},{' '}
                      {region.y})
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="review-actions" aria-live="polite">
              {candidate && candidate.status !== 'candidate' ? (
                <p>
                  <Status value={candidate.status} /> Version{' '}
                  {candidate.version}
                </p>
              ) : (
                <>
                  <button
                    disabled={working}
                    className="primary"
                    onClick={() => void decide('approve')}
                  >
                    Approve baseline
                  </button>
                  <button
                    disabled={working}
                    className="secondary"
                    onClick={() => void decide('reject')}
                  >
                    Reject change
                  </button>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function Workspace({
  session,
  logout,
  switchWorkspace,
}: {
  session: Session;
  logout: () => void;
  switchWorkspace: (id: string) => Promise<void>;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [section, setSection] = useState<'history' | 'suite'>('history');
  const [suite, setSuite] = useState<Suite | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [runId, setRunId] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [variant, setVariant] = useState('original');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const projectPath = `/projects/${projectId}`;

  useEffect(() => {
    let live = true;
    api<Project[]>('/projects')
      .then((items) => {
        if (live) {
          setProjects(items);
          setProjectId(items[0]?.id ?? '');
        }
      })
      .catch((error: unknown) => {
        if (live) setIssue(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    Promise.all([
      api<{ suite: Suite | null }>(`${projectPath}/suite`),
      api<Run[]>(`${projectPath}/runs`),
    ])
      .then(([configuration, runs]) => {
        if (!live) return;
        setSuite(configuration.suite);
        setHistory(runs);
        setRunId((selected) => selected || runs[0]?.id || '');
      })
      .catch((error: unknown) => {
        if (live) setIssue(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [projectId, projectPath, refresh]);

  useEffect(() => {
    if (!projectId || !runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const data = await api<Detail>(`${projectPath}/runs/${runId}`);
        if (!live) return;
        setDetail(data);
        setHistory((runs) =>
          runs.map((run) =>
            run.id === data.id
              ? { ...run, states: data.jobs.map((job) => job.state) }
              : run,
          ),
        );
        if (
          data.jobs.some(
            (job) => job.state === 'running' || job.state === 'queued',
          )
        )
          timer = setTimeout(() => void poll(), 650);
      } catch (error) {
        if (live) setIssue(errorText(error));
      }
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectId, projectPath, runId, refresh]);

  function selectProject(id: string) {
    setProjectId(id);
    setHistory([]);
    setSuite(null);
    setRunId('');
    setDetail(null);
    setSection('history');
    setIssue('');
  }
  async function createProject(event: FormEvent) {
    event.preventDefault();
    setIssue('');
    setBusy(true);
    try {
      const project = await api<Project>('/projects', 'POST', { name });
      setProjects((items) => [...items, project]);
      selectProject(project.id);
      setName('');
      setCreating(false);
      await api(`/projects/${project.id}/suite`, 'PUT', {
        checkpoints: initialCheckpoints,
      });
      setRefresh((value) => value + 1);
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveSuite(checks: Checkpoint[]) {
    setIssue('');
    try {
      setSuite(
        await api<Suite>(`${projectPath}/suite`, 'PUT', {
          checkpoints: checks,
        }),
      );
      setSection('history');
    } catch (error) {
      setIssue(errorText(error));
    }
  }
  async function submitRun(event: FormEvent) {
    event.preventDefault();
    if (!suite) return;
    setBusy(true);
    setIssue('');
    try {
      const run = await api<Run>(
        `${projectPath}/runs`,
        'POST',
        { suiteId: suite.id, variant },
        crypto.randomUUID(),
      );
      setRunId(run.id);
      setDetail(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    try {
      await api(`${projectPath}/runs/${runId}/cancel`, 'POST');
      setRefresh((value) => value + 1);
    } catch (error) {
      setIssue(errorText(error));
    }
  }
  async function selectWorkspace(id: string) {
    setBusy(true);
    try {
      await switchWorkspace(id);
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const project = projects.find((item) => item.id === projectId);
  const running = detail?.jobs.some(
    (job) => job.state === 'running' || job.state === 'queued',
  );

  return (
    <div className="shell">
      <header className="header">
        <Brand />
        <div className="workspace-controls">
          {session.workspaces.length > 1 ? (
            <select
              aria-label="Workspace"
              value={session.workspace.id}
              disabled={busy}
              onChange={(event) => void selectWorkspace(event.target.value)}
            >
              {session.workspaces.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{session.workspace.name}</span>
          )}
          <button className="signout" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <div className="side-heading">
          <h2>Projects</h2>
          <button
            className="icon-button"
            aria-label="New project"
            onClick={() => setCreating(!creating)}
          >
            +
          </button>
        </div>
        {creating && (
          <form onSubmit={createProject} className="new-project">
            <label>
              Project name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <button className="primary" disabled={busy}>
              Create project
            </button>
          </form>
        )}
        <nav aria-label="Projects">
          {projects.map((item) => (
            <button
              key={item.id}
              type="button"
              className="project-link"
              disabled={busy}
              aria-current={item.id === projectId ? 'page' : undefined}
              onClick={() => {
                if (item.id !== projectId) selectProject(item.id);
              }}
            >
              <span aria-hidden="true" className="project-icon">
                {item.name.slice(0, 1).toUpperCase()}
              </span>
              {item.name}
            </button>
          ))}
        </nav>
        {!projects.length && !loading && (
          <p className="muted side-empty">No projects yet</p>
        )}
      </aside>
      <main className="content">
        {issue && (
          <div role="alert" className="error">
            <span>{issue}</span>
            <button aria-label="Dismiss error" onClick={() => setIssue('')}>
              ×
            </button>
          </div>
        )}
        {project ? (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">Project</p>
                <h1>{project.name}</h1>
              </div>
              {running && (
                <button className="secondary" onClick={() => void cancel()}>
                  Cancel run
                </button>
              )}
            </div>
            <div className="page-tabs">
              <button
                aria-pressed={section === 'history'}
                onClick={() => setSection('history')}
              >
                Run history
              </button>
              <button
                aria-pressed={section === 'suite'}
                onClick={() => setSection('suite')}
              >
                Test suite
              </button>
            </div>
            {section === 'suite' ? (
              <SuiteEditor
                key={suite?.id ?? 'new'}
                suite={suite}
                save={saveSuite}
              />
            ) : (
              <>
                <form className="panel run-controls" onSubmit={submitRun}>
                  <label>
                    Fixture variant
                    <select
                      value={variant}
                      onChange={(event) => setVariant(event.target.value)}
                    >
                      {Object.entries(variants).map(([key, value]) => (
                        <option key={key} value={key}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" disabled={!suite || busy}>
                    Start run
                  </button>
                  {!suite && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setSection('suite')}
                    >
                      Configure suite
                    </button>
                  )}
                </form>
                <div className="run-layout">
                  <section className="panel history" aria-label="Runs">
                    <div className="panel-heading">
                      <h2>Runs</h2>
                      <span className="count">{history.length}</span>
                    </div>
                    {history.length ? (
                      history.map((run) => (
                        <button
                          className="run-row"
                          aria-current={run.id === runId ? 'true' : undefined}
                          key={run.id}
                          onClick={() => {
                            if (run.id !== runId) {
                              setRunId(run.id);
                              setDetail(null);
                            }
                          }}
                        >
                          <span>
                            {variants[run.variant]}
                            <small>
                              {new Date(run.created_at).toLocaleTimeString(
                                undefined,
                                { hour: 'numeric', minute: '2-digit' },
                              )}{' '}
                              · {run.id.slice(0, 8)}
                            </small>
                          </span>
                          <Status value={runStatus(run.states)} />
                        </button>
                      ))
                    ) : (
                      <p className="empty">
                        Run this suite to capture evidence.
                      </p>
                    )}
                  </section>
                  {detail ? (
                    <Review
                      key={detail.id}
                      projectId={projectId}
                      run={detail}
                      report={setIssue}
                    />
                  ) : (
                    <div className="panel empty" aria-live="polite">
                      {runId
                        ? 'Loading run…'
                        : 'Select a run to inspect its screenshots.'}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        ) : (
          <section className="panel welcome">
            <h1>
              {loading ? 'Loading workspace…' : 'Visual review workspace'}
            </h1>
            <p className="muted">
              Create a project to capture a dashboard and approve its first
              baseline.
            </p>
            <button className="primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [token, setToken] = useState('');
  const [issue, setIssue] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    api<Session>('/session')
      .then(setSession)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setIssue('');
    setWorking(true);
    try {
      setSession(await api<Session>('/session', 'POST', { token }));
      setToken('');
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setWorking(false);
    }
  }
  async function logout() {
    await api('/session', 'DELETE').catch(() => undefined);
    setSession(null);
  }
  if (session)
    return (
      <Workspace
        key={session.workspace.id}
        session={session}
        logout={() => void logout()}
        switchWorkspace={async (workspaceId) =>
          setSession(await api<Session>('/session', 'PATCH', { workspaceId }))
        }
      />
    );
  return (
    <main className="login">
      <form className="login-card" onSubmit={login}>
        <Brand />
        <h1>{checking ? 'Checking session…' : 'Sign in'}</h1>
        <p className="muted">Use your local workspace operator token.</p>
        <label>
          Operator token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {issue && (
          <p role="alert" className="error">
            {issue}
          </p>
        )}
        <button className="primary" disabled={working || checking}>
          {working ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
