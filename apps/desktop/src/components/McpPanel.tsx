import { useCallback, useEffect, useState } from 'react';

/** Typed client for the MCP endpoints. */
export interface McpServerSummary {
  name: string;
  version: string;
  provider: string | null;
  transport: string | null;
  tools: string[];
  trustLevel: string;
  approvalPolicy: string;
  installStatus: string;
  enabled: boolean;
}

export interface McpApi {
  list(): Promise<{ servers: McpServerSummary[] }>;
  register(server: Record<string, unknown>): Promise<{ server: McpServerSummary }>;
  install(name: string, version: string): Promise<{ ok: boolean; status: string; reason?: string; server?: McpServerSummary }>;
  review(name: string, version: string, approved: boolean, reviewer?: string): Promise<{ ok: boolean; status: string; server?: McpServerSummary }>;
  remove(name: string, version: string): Promise<{ ok: boolean }>;
  gate(server: string, tool: string, version?: string): Promise<{ allowed: boolean; reason: string; usedVersion?: string }>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string; reason?: string };
    throw new Error(err.error ?? err.reason ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createMcpApi(base: string = DEFAULT_BASE): McpApi {
  return {
    list: () => req(base, '/mcp'),
    register: (server) => req(base, '/mcp/register', { method: 'POST', body: JSON.stringify({ server }) }),
    install: (name, version) => req(base, '/mcp/install', { method: 'POST', body: JSON.stringify({ name, version }) }),
    review: (name, version, approved, reviewer) =>
      req(base, '/mcp/review', { method: 'POST', body: JSON.stringify({ name, version, approved, reviewer }) }),
    remove: (name, version) => req(base, '/mcp/remove', { method: 'POST', body: JSON.stringify({ name, version }) }),
    gate: (server, tool, version) =>
      req(base, '/mcp/gate', { method: 'POST', body: JSON.stringify({ server, tool, version }) }),
  };
}

function statusClass(s: string): string {
  if (s === 'INSTALLED') return 'st-active';
  if (s === 'PENDING_REVIEW') return 'st-working';
  if (s === 'BLOCKED') return 'st-failed';
  return 'st-idle';
}

/**
 * MCP panel (§46, §73): server registry with trust/approval badges,
 * install flow (unknown ⇒ BLOCKED by default), review decisions,
 * and a pre-call gate check demo.
 */
export function McpPanel(props: { mcp?: McpApi }) {
  const [api] = useState<McpApi>(() => props.mcp ?? createMcpApi());
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gateResult, setGateResult] = useState<{ allowed: boolean; reason: string } | null>(null);
  const [rName, setRName] = useState('playwright');
  const [rVersion, setRVersion] = useState('1.0.0');
  const [gServer, setGServer] = useState('github');
  const [gTool, setGTool] = useState('get_file_contents');

  const refresh = useCallback(async () => {
    try {
      const { servers: s } = await api.list();
      setServers(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRegister = () =>
    run(() =>
      api.register({ name: rName, version: rVersion, provider: 'community', transport: 'stdio' }),
    );

  const doGate = () =>
    run(async () => {
      const v = await api.gate(gServer, gTool);
      setGateResult(v);
    });

  return (
    <div className="mcp-panel">
      {error && <div className="banner err">{error}</div>}
      <h4 style={{ margin: '4px 0' }}>MCP servers <span className="muted">({servers.length})</span></h4>
      <ul className="ev-list">
        {servers.map((s) => (
          <li key={`${s.name}@${s.version}`} style={{ marginBottom: 6 }}>
            <span className={`status-dot ${statusClass(s.installStatus)}`} style={{ display: 'inline-block', marginRight: 6 }} />
            <b>{s.name}@{s.version}</b>{' '}
            <span className="muted">{s.provider} · {s.transport} · tools: {s.tools.join(', ') || '—'}</span>{' '}
            <span className="pill">{s.trustLevel}</span>{' '}
            <span className="pill">{s.approvalPolicy}</span>{' '}
            <span className="pill">{s.installStatus}</span>{' '}
            {!s.enabled && <span className="pill">disabled</span>}
            <span style={{ marginLeft: 8 }}>
              <button disabled={busy} onClick={() => run(() => api.install(s.name, s.version))}>Install</button>{' '}
              {s.installStatus === 'PENDING_REVIEW' && (
                <>
                  <button disabled={busy} onClick={() => run(() => api.review(s.name, s.version, true))}>Approve</button>{' '}
                  <button disabled={busy} onClick={() => run(() => api.review(s.name, s.version, false))}>Reject</button>{' '}
                </>
              )}
              <button disabled={busy} onClick={() => run(() => api.remove(s.name, s.version))}>Remove</button>
            </span>
          </li>
        ))}
      </ul>
      <h4 style={{ margin: '12px 0 4px' }}>Register new server</h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="name" />
        <input value={rVersion} onChange={(e) => setRVersion(e.target.value)} placeholder="version" />
        <button disabled={busy} onClick={doRegister}>Register</button>
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>Tool-call gate check <span className="muted">(§73)</span></h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={gServer} onChange={(e) => setGServer(e.target.value)} placeholder="server" />
        <input value={gTool} onChange={(e) => setGTool(e.target.value)} placeholder="tool" />
        <button disabled={busy} onClick={doGate}>Check gate</button>
      </div>
      {gateResult && (
        <div className={`banner ${gateResult.allowed ? '' : 'err'}`}>
          {gateResult.allowed ? 'ALLOWED' : 'DENIED'} — {gateResult.reason}
        </div>
      )}
    </div>
  );
}
