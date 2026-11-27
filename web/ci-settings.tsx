import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from './api.ts';

type Credential = {
  id: string;
  label: string;
  baseline_branch: string;
  expires_at: string;
  revoked_at: string | null;
};

export function CiSettings({ projectPath }: { projectPath: string }) {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [label, setLabel] = useState('GitHub Actions');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [working, setWorking] = useState(false);
  const [copyState, setCopyState] = useState('');
  const [issue, setIssue] = useState('');
  const endpoint = `${projectPath}/ci-credentials`;
  useEffect(() => {
    let active = true;
    api<Credential[]>(endpoint)
      .then((items) => {
        if (active) setCredentials(items);
      })
      .catch((error: unknown) => {
        if (active) setIssue(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  async function issueCredential(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setIssue('');
    setCopyState('');
    try {
      const { token: secret, ...credential } = await api<
        Credential & { token: string }
      >(endpoint, 'POST', { label, baselineBranch: branch });
      setCredentials((items) => [credential, ...(items ?? [])]);
      setToken(secret);
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setWorking(false);
    }
  }
  async function revoke(id: string) {
    setWorking(true);
    setIssue('');
    try {
      await api(`${endpoint}/${id}`, 'DELETE');
      setCredentials(await api<Credential[]>(endpoint));
      setToken('');
    } catch (error) {
      setIssue(errorText(error));
    } finally {
      setWorking(false);
    }
  }
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopyState('Copied to clipboard');
    } catch {
      setCopyState('Select the credential and copy it manually.');
    }
  }
  return (
    <div className="integration-layout">
      <section className="panel integration">
        <h2>CI credentials</h2>
        <p className="muted">
          CI can submit captures for this project. Reviewers approve baselines
          from the configured branch.
        </p>
        {issue && (
          <p role="alert" className="error">
            {issue}
          </p>
        )}
        {credentials && (
          <>
            <form className="credential-form" onSubmit={issueCredential}>
              <label>
                Credential name
                <input
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Baseline branch
                <input
                  required
                  maxLength={160}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
              <button className="primary" disabled={working}>
                Create credential
              </button>
            </form>
            {token && (
              <div className="secret-panel">
                <label>
                  New CI credential
                  <input
                    readOnly
                    value={token}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <p>
                  Save this as <code>VERITYUI_CI_TOKEN</code> in your CI
                  secrets. It is shown once.
                </p>
                <div className="secret-actions">
                  <button
                    className="secondary"
                    onClick={() => void copyToken()}
                  >
                    Copy credential
                  </button>
                  <button className="text-button" onClick={() => setToken('')}>
                    Dismiss
                  </button>
                </div>
                {copyState && <p role="status">{copyState}</p>}
              </div>
            )}
            {credentials.length ? (
              <ul className="credential-list">
                {credentials.map((credential) => {
                  const expired =
                    Date.parse(credential.expires_at) <= Date.now();
                  return (
                    <li key={credential.id}>
                      <div>
                        <strong>{credential.label}</strong>
                        <small>
                          <code>{credential.baseline_branch}</code> ·{' '}
                          {credential.revoked_at
                            ? 'Revoked'
                            : expired
                              ? 'Expired'
                              : `Expires ${new Date(credential.expires_at).toLocaleDateString()}`}
                        </small>
                      </div>
                      {!credential.revoked_at && !expired && (
                        <button
                          className="secondary"
                          disabled={working}
                          onClick={() => void revoke(credential.id)}
                          aria-label={`Revoke ${credential.label}`}
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted credential-empty">
                No credentials for this project yet.
              </p>
            )}
          </>
        )}
      </section>
      <section className="panel integration commands">
        <h2>Submit your first run</h2>
        <p className="muted">
          Install the VerityUI CLI in your repository and run{' '}
          <code>npx verityui init</code> once. Set <code>VERITYUI_API_URL</code>{' '}
          and <code>VERITYUI_CI_TOKEN</code> in the job environment.
        </p>
        <pre>
          <code>
            {
              'npx verityui capture --output captures\nnpx verityui upload --input captures --wait'
            }
          </code>
        </pre>
        <p className="muted">
          GitHub Actions supplies the commit and branch. For other runners, pass{' '}
          <code>--commit</code> and <code>--branch</code> to the upload command.
        </p>
      </section>
    </div>
  );
}
