import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';

/**
 * Activity center — spec §67 (Agent Activity) + §68 (Run / Trace System).
 * Realtime timestamped event stream (polls GET /api/activity); any row
 * linked to an agent run opens the Run Detail drawer with every §68 field.
 * The BottomPanel's "AI Activity" tab (raw audit log) is kept as-is.
 */

export interface ActivityItem {
  id: string;
  ts: string;
  kind: 'audit' | 'event';
  source: string;
  label: string;
  detail: Record<string, unknown>;
  runId?: string;
}

export interface RunSummary {
  runId: string;
  agentId: string;
  taskId: string;
  status: string;
  outcome: string | null;
  steps: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunDetail {
  runId: string;
  status: string;
  agent: { id: string; name: string; displayName: string; version: number } | null;
  agentVersion: number | null;
  task: { id: string; title: string } | null;
  model: string;
  modelProvider: string;
  startedAt: string;
  finishedAt: string | null;
  inputRefs: string[];
  toolsUsed: { at: string; name: string; result: string }[];
  commands: string[];
  filesChanged: { path: string; kind: string }[];
  artifacts: unknown[];
  errors: { at: string; message: string }[];
  retries: number;
  handoffs: string[];
  approvals: { id: string; action: string; status: string; decision: string; decidedBy: string }[];
  evidence: unknown[];
  trace: { at: string; phase: string; action: string; result: string }[];
  finalOutcome: string | null;
}

export interface ActivityApi {
  stream(limit?: number): Promise<{ items: ActivityItem[] }>;
  runs(): Promise<{ runs: RunSummary[] }>;
  run(id: string): Promise<RunDetail>;
}

/** fetch client mirroring apps/desktop/src/api.ts `req`. */
export function createActivityApi(base = 'http://localhost:3100/api'): ActivityApi {
  async function req<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const e = new Error(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
      ) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  return {
    stream: (limit = 100) => req<{ items: ActivityItem[] }>(`/activity?limit=${limit}`),
    runs: () => req<{ runs: RunSummary[] }>('/runs'),
    run: (id) => req<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  };
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString();
}

function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="card-title">{title}</div>
      <div className="card-meta">{children}</div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <span className="muted">{k}: </span>
      <span>{v}</span>
    </div>
  );
}

export function RunDrawer({
  runId,
  api,
  onClose,
}: {
  runId: string;
  api: ActivityApi;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDetail(null);
    setError('');
    api.run(runId).then(setDetail).catch((e: Error) => setError(e.message));
  }, [api, runId]);

  return (
    <div className="detail wide">
      <div className="detail-head">
        <h2>Run Detail <span className="count">§68</span></h2>
        <button onClick={onClose}>Close</button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {!detail && !error && <div className="muted">Loading…</div>}
      {detail && (
        <div className="drawer-body">
            <Section title="Identity">
              <Kv k="runId" v={<code>{detail.runId}</code>} />
              <Kv k="status" v={<span className="pill">{detail.status}</span>} />
              <Kv k="agent" v={detail.agent ? `${detail.agent.displayName} (${detail.agent.name})` : '—'} />
              <Kv k="agentVersion" v={detail.agentVersion ?? '—'} />
              <Kv k="task" v={detail.task ? `${detail.task.title} (${detail.task.id.slice(0, 8)})` : '—'} />
              <Kv k="model" v={detail.model || '—'} />
              <Kv k="modelProvider" v={detail.modelProvider} />
            </Section>
            <Section title="Timing">
              <Kv k="startedAt" v={fmtTs(detail.startedAt)} />
              <Kv k="finishedAt" v={fmtTs(detail.finishedAt)} />
              <Kv k="finalOutcome" v={detail.finalOutcome ?? '—'} />
              <Kv k="retries" v={detail.retries} />
            </Section>
            <Section title={`Input refs (${detail.inputRefs.length})`}>
              {detail.inputRefs.map((r) => (
                <div key={r}><code>{r}</code></div>
              ))}
            </Section>
            <Section title={`Tools used (${detail.toolsUsed.length})`}>
              {detail.toolsUsed.length === 0 && <span className="muted">none</span>}
              {detail.toolsUsed.map((t, i) => (
                <div key={i}>
                  <code>{t.name}</code> <span className="muted">{t.result}</span>{' '}
                  <span className="muted">{fmtTime(t.at)}</span>
                </div>
              ))}
            </Section>
            <Section title={`Commands (${detail.commands.length})`}>
              {detail.commands.length === 0 && <span className="muted">none recorded</span>}
              {detail.commands.map((c, i) => (
                <div key={i}><code>{c}</code></div>
              ))}
            </Section>
            <Section title={`Files changed (${detail.filesChanged.length})`}>
              {detail.filesChanged.length === 0 && <span className="muted">none recorded</span>}
              {detail.filesChanged.map((f, i) => (
                <div key={i}><code>{f.path}</code> <span className="muted">({f.kind})</span></div>
              ))}
            </Section>
            <Section title={`Artifacts / evidence (${detail.artifacts.length})`}>
              {detail.artifacts.length === 0 && <span className="muted">none</span>}
              {detail.artifacts.map((a, i) => (
                <div key={i}><code>{JSON.stringify(a).slice(0, 160)}</code></div>
              ))}
            </Section>
            <Section title={`Errors (${detail.errors.length})`}>
              {detail.errors.length === 0 && <span className="muted">none</span>}
              {detail.errors.map((e, i) => (
                <div key={i} className="banner err" style={{ marginTop: 4 }}>
                  {e.message} <span className="muted">{fmtTime(e.at)}</span>
                </div>
              ))}
            </Section>
            <Section title={`Handoffs (${detail.handoffs.length})`}>
              {detail.handoffs.length === 0 && <span className="muted">none</span>}
              {detail.handoffs.map((h, i) => (
                <div key={i}><code>{h}</code></div>
              ))}
            </Section>
            <Section title={`Approvals (${detail.approvals.length})`}>
              {detail.approvals.length === 0 && <span className="muted">none</span>}
              {detail.approvals.map((a) => (
                <div key={a.id}>
                  <span className="pill">{a.status}</span> {a.action}{' '}
                  <span className="muted">{a.decision} by {a.decidedBy}</span>
                </div>
              ))}
            </Section>
            <Section title={`Trace (${detail.trace.length} steps)`}>
              {detail.trace.map((s, i) => (
                <div key={i} className="act-row">
                  <span className="muted">{fmtTime(s.at)}</span>
                  <span className="pill">{s.phase}</span>
                  <span>{s.action}</span>
                  <span className="muted">{s.result.slice(0, 120)}</span>
                </div>
              ))}
            </Section>
            <div className="muted" style={{ marginTop: 8 }}>
              Sensitive values are redacted as *** (§68).
            </div>
          </div>
        )}
    </div>
  );
}

export interface ActivityPanelProps {
  api?: ActivityApi;
  /** ms between refreshes; 0 disables polling. Default 3000. */
  pollMs?: number;
}

export function ActivityPanel({ api, pollMs = 3000 }: ActivityPanelProps) {
  const client = api ?? createActivityApi();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .stream(100)
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
    client
      .runs()
      .then((r) => setRuns(r.runs))
      .catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return (
    <div className="activity-panel">
      <div className="board-head">
        <h2>Activity <span className="count">§67 · §68</span></h2>
        <span className="muted">{runs.length} runs · live</span>
      </div>
      {error && <div className="banner err">{error}</div>}

      {runs.length > 0 && (
        <>
          <h4>Runs ({runs.length}) — click for trace</h4>
          {runs.map((r) => (
            <button
              key={r.runId}
              className="act-row run-row"
              onClick={() => setOpenRun(r.runId)}
              title="Open run detail"
            >
              <span className="pill">{r.status}</span>
              <code>{r.runId.slice(0, 8)}</code>
              <span className="muted">agent {r.agentId.slice(0, 8)}</span>
              <span className="muted">{r.steps} steps</span>
              <span className="muted">{fmtTime(r.startedAt)}</span>
            </button>
          ))}
        </>
      )}

      <h4>Realtime stream</h4>
      {items.length === 0 && <div className="muted">No activity yet.</div>}
      {items.map((it) => (
        <div key={it.id} className="act-row">
          <span className="muted act-ts">{fmtTime(it.ts)}</span>
          <span className={`pill ${it.kind === 'event' ? 'pill-event' : ''}`}>{it.kind}</span>
          <span>{it.label}</span>
          {it.runId && (
            <button className="link" onClick={() => setOpenRun(it.runId!)}>
              run {it.runId.slice(0, 8)}
            </button>
          )}
        </div>
      ))}

      {openRun && (
        <RunDrawer runId={openRun} api={client} onClose={() => setOpenRun(null)} />
      )}
    </div>
  );
}
