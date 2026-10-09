import { useEffect, useState } from 'react';

/** Typed client for the QA endpoints (mirrors the req pattern in api.ts). */
export interface QaAgent {
  id: string;
  name: string;
  displayName: string;
  jobTitle: string;
  status: string;
  autonomyLevel: number;
}

export interface QaCategorySummary {
  category: string;
  verdict: 'PASS' | 'FAIL' | 'SKIPPED';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface QaFailure {
  attempt: number;
  category: string;
  classification: string;
  owner: string;
  message: string;
  at: string;
}

export interface QaRun {
  id: string;
  taskId: string;
  categories: string[];
  actor: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  verdict: string | null;
  attempts: number;
  escalated: boolean;
  evidenceId: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    categories: QaCategorySummary[];
    failures: QaFailure[];
  } | null;
}

export interface QaApi {
  org(): Promise<{ lead: QaAgent | null; specialists: QaAgent[] }>;
  createSpecialist(kind: string): Promise<{ specialist: QaAgent }>;
  runQa(input: { taskId: string; categories: string[] }): Promise<{ run: QaRun }>;
  runs(): Promise<{ runs: QaRun[] }>;
  run(id: string): Promise<{ run: QaRun }>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createQaApi(base: string = DEFAULT_BASE): QaApi {
  return {
    org: () => req(base, '/qa/org'),
    createSpecialist: (kind: string) =>
      req(base, '/qa/specialists', { method: 'POST', body: JSON.stringify({ kind }) }),
    runQa: (input) =>
      req(base, '/qa/runs', { method: 'POST', body: JSON.stringify(input) }),
    runs: () => req(base, '/qa/runs'),
    run: (id: string) => req(base, `/qa/runs/${encodeURIComponent(id)}`),
  };
}

export const ALL_CATEGORIES = [
  'unit',
  'integration',
  'api',
  'e2e',
  'regression',
  'ui',
  'performance',
  'security',
  'database',
  'migration',
  'smoke',
] as const;

function verdictClass(v: string): string {
  if (v === 'PASS') return 'st-working';
  if (v === 'FAIL') return 'st-failed';
  return 'st-idle';
}

/**
 * QA panel (§36–§38): org chart, category selection, run trigger,
 * per-category results and classified failures with owner badges.
 * Props-based; the coordinator mounts it where the workflow needs it.
 */
export function QaPanel(props: { taskId: string | null; qa?: QaApi }) {
  const { taskId } = props;
  const [qa] = useState<QaApi>(() => props.qa ?? createQaApi());
  const [org, setOrg] = useState<{ lead: QaAgent | null; specialists: QaAgent[] } | null>(null);
  const [cats, setCats] = useState<string[]>(['unit']);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<QaRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    qa.org().then(setOrg).catch(() => setOrg(null));
  }, [qa]);

  const toggleCat = (c: string) =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const startRun = async () => {
    if (!taskId || running) return;
    setRunning(true);
    setError(null);
    try {
      const { run: r } = await qa.runQa({ taskId, categories: cats });
      setRun(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="qa-panel" style={{ padding: 12, overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 8px' }}>QA <span className="muted">§36–§38</span></h3>

      <h4 className="muted" style={{ margin: '8px 0 4px' }}>Organization</h4>
      {!org && <div className="muted">Loading QA org…</div>}
      {org && (
        <div>
          {org.lead && (
            <div className="org-row">
              <span className="status-dot st-working" />
              <span className="org-name">{org.lead.displayName}</span>
              <span className="org-role">{org.lead.jobTitle}</span>
            </div>
          )}
          {org.specialists.map((s) => (
            <div className="org-row" key={s.id}>
              <span className="tree-indent">└</span>
              <span className="status-dot st-idle" />
              <span className="org-name">{s.displayName}</span>
              <span className="org-role">{s.jobTitle}</span>
            </div>
          ))}
          {org.specialists.length === 0 && (
            <div className="muted">No specialists yet — created on demand per task.</div>
          )}
        </div>
      )}

      <h4 className="muted" style={{ margin: '12px 0 4px' }}>Categories</h4>
      <div className="btn-row">
        {ALL_CATEGORIES.map((c) => (
          <label key={c} className="pill" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cats.includes(c)}
              onChange={() => toggleCat(c)}
              style={{ marginRight: 4 }}
            />
            {c}
          </label>
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button onClick={startRun} disabled={!taskId || running || cats.length === 0}>
          {running ? 'Running QA…' : 'Run QA'}
        </button>
        {!taskId && <span className="muted">Select a task to run QA.</span>}
      </div>

      {error && <div className="banner err">{error}</div>}

      {run && (
        <div style={{ marginTop: 12 }}>
          <h4 style={{ margin: '8px 0 4px' }}>
            Run <span className="muted">{run.id.slice(0, 8)}</span>{' '}
            <span className={`status-dot ${verdictClass(run.verdict ?? '')}`} style={{ display: 'inline-block' }} />{' '}
            <b>{run.verdict}</b>{' '}
            <span className="muted">
              attempts={run.attempts}{run.escalated ? ' · ESCALATED' : ''}
            </span>
          </h4>
          {run.summary && (
            <>
              <ul className="ev-list">
                {run.summary.categories.map((c) => (
                  <li key={c.category}>
                    <span className={`status-dot ${verdictClass(c.verdict)}`} style={{ display: 'inline-block', marginRight: 6 }} />
                    <b>{c.category}</b>{' '}
                    <span className="muted">
                      {c.passed}/{c.total} passed · {c.failed} failed · {c.skipped} skipped · {c.durationMs}ms
                    </span>
                  </li>
                ))}
              </ul>
              {run.summary.failures.length > 0 && (
                <>
                  <h4 className="muted" style={{ margin: '8px 0 4px' }}>Failures</h4>
                  <ul className="ev-list">
                    {run.summary.failures.map((f, i) => (
                      <li key={i}>
                        <span className="pill">{f.classification}</span>{' '}
                        <span className="pill">owner: {f.owner}</span>{' '}
                        <span className="muted">attempt {f.attempt} · {f.category}</span>
                        <div className="muted" style={{ marginTop: 2 }}>{f.message}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
