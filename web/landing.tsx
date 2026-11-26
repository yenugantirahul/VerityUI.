import { useState, type ReactNode } from 'react';
import baseline from './assets/baseline.png';
import current from './assets/current.png';
import diff from './assets/diff.png';

const evidence = {
  Diff: { src: diff, alt: 'Chart recolor highlighted in the comparison diff' },
  Baseline: {
    src: baseline,
    alt: 'Analytics dashboard before the chart recolor',
  },
  Candidate: {
    src: current,
    alt: 'Analytics dashboard after the chart recolor',
  },
};

export function Brand() {
  return (
    <span className="brand">
      <span className="logo" aria-hidden="true">
        <i />
        <i />
      </span>
      VerityUI
    </span>
  );
}

export function Landing({ signIn }: { signIn: ReactNode }) {
  const [view, setView] = useState<keyof typeof evidence>('Diff');
  return (
    <div className="landing">
      <header className="site-header">
        <nav className="site-wrap site-nav" aria-label="Main navigation">
          <a className="brand-link" href="#top" aria-label="VerityUI home">
            <Brand />
          </a>
          <div className="site-nav-links">
            <a href="#workflow">Workflow</a>
            <a href="#quickstart">Quickstart</a>
          </div>
          <a className="site-signin" href="#sign-in">
            Sign in
          </a>
        </nav>
      </header>
      <main>
        <section className="site-wrap hero" id="top">
          <div className="hero-copy">
            <p className="hero-label">
              <span /> Visual verification for code changes
            </p>
            <h1>
              Catch unintended
              <br className="hero-break" /> UI changes <em>before merge.</em>
            </h1>
            <p className="hero-description">
              Verify what coding agents build. Compare the browser before and
              after a change, trace differences to elements, and review them
              against the intended scope.
            </p>
            <div className="hero-actions">
              <a className="site-button site-primary" href="#sign-in">
                Open workspace
              </a>
              <a className="site-button site-secondary" href="#quickstart">
                Start with the CLI
              </a>
            </div>
            <p className="hero-support">
              Playwright capture <span>·</span> GitHub Actions <span>·</span>{' '}
              Human baseline approval
            </p>
          </div>
          <figure
            className="hero-preview"
            aria-label="Interactive example verification report"
          >
            <div className="preview-heading">
              <div className="preview-ident">
                <span className="preview-project" aria-hidden="true">
                  H
                </span>
                <div>
                  <strong>Harbor Analytics</strong>
                  <small>Example verification</small>
                </div>
              </div>
              <span className="preview-status">
                <i /> Visual change
              </span>
            </div>
            <div className="preview-toolbar">
              <code>/analytics</code>
              <div
                className="preview-switch"
                role="group"
                aria-label="Example evidence view"
              >
                {(Object.keys(evidence) as (keyof typeof evidence)[]).map(
                  (tab) => (
                    <button
                      key={tab}
                      aria-pressed={view === tab}
                      onClick={() => setView(tab)}
                    >
                      {tab}
                    </button>
                  ),
                )}
              </div>
            </div>
            <div className="preview-image">
              <img
                src={evidence[view].src}
                alt={evidence[view].alt}
                width="1200"
                height="807"
              />
            </div>
            <figcaption>
              <span className="preview-marker" aria-hidden="true" />{' '}
              <span>
                <strong>Chart series color changed</strong>
                <small>
                  Deterministic pixel evidence from the bundled fixture
                </small>
              </span>
            </figcaption>
          </figure>
        </section>
        <section className="workflow-section" id="workflow">
          <div className="site-wrap">
            <h2>From pull request to review.</h2>
            <div className="workflow-grid">
              <article>
                <h3>Capture in CI</h3>
                <p>
                  Run Playwright against your app across the routes and
                  viewports you configure.
                </p>
              </article>
              <article>
                <h3>Inspect the evidence</h3>
                <p>
                  Review pixel diffs, before-and-after crops, and element-level
                  layout and style changes.
                </p>
              </article>
              <article>
                <h3>Review against intent</h3>
                <p>
                  Declare allowed changes and protect critical routes or
                  components with a YAML contract.
                </p>
              </article>
            </div>
          </div>
        </section>
        <section
          className="site-wrap getting-started"
          aria-label="Getting started"
        >
          <div className="quickstart" id="quickstart">
            <h2>Run your first comparison.</h2>
            <p>
              Build the CLI from this project and start the app you want to
              verify.
            </p>
            <pre>
              <code>
                {
                  'npm run build:server\nnpm run cli -- init --base-url http://localhost:3000\nnpm run cli -- capture --output data/baseline\nnpm run cli -- verify --reference data/baseline'
                }
              </code>
            </pre>
            <p>
              Capture your baseline, make a frontend change, then run
              verification and open the generated HTML report.
            </p>
          </div>
          <div id="sign-in">{signIn}</div>
        </section>
      </main>
      <footer className="site-wrap site-footer">
        <Brand />
        <a href="#top">Back to top</a>
      </footer>
    </div>
  );
}
