import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

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
  serverUrl: string | null;
  oauthConfigured: boolean;
  negotiatedVersion: string | null;
  /** true when a live remote connector exists in this server process (stateless HTTP) */
  connected: boolean;
}

export interface McpOAuthStatus {
  configured: boolean;
  hasToken: boolean;
  expired: boolean | null;
  scopes: string | null;
}

export interface McpApi {
  list(): Promise<{ servers: McpServerSummary[] }>;
  register(server: Record<string, unknown>): Promise<{ server: McpServerSummary }>;
  install(name: string, version: string): Promise<{ ok: boolean; status: string; reason?: string; server?: McpServerSummary }>;
  review(name: string, version: string, approved: boolean, reviewer?: string): Promise<{ ok: boolean; status: string; server?: McpServerSummary }>;
  remove(name: string, version: string): Promise<{ ok: boolean }>;
  gate(server: string, tool: string, version?: string): Promise<{ allowed: boolean; reason: string; usedVersion?: string }>;
  remoteConnect(name: string, version: string): Promise<{ ok: boolean; tools?: string[]; resources?: string[]; prompts?: string[]; error?: string }>;
  oauthStart(name: string, version: string, redirectUri: string): Promise<{ authorizationUrl: string; state: string }>;
  oauthStatus(name: string, version: string): Promise<McpOAuthStatus>;
  oauthRefresh(name: string, version: string): Promise<{ ok: boolean }>;
  getServerMode(): Promise<{ enabled: boolean }>;
  setServerMode(enabled: boolean): Promise<{ enabled: boolean }>;
}

const DEFAULT_BASE = defaultApiBase();

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
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
    remoteConnect: (name, version) =>
      req(base, '/mcp/remote/connect', { method: 'POST', body: JSON.stringify({ name, version }) }),
    oauthStart: (name, version, redirectUri) =>
      req(base, '/mcp/oauth/start', { method: 'POST', body: JSON.stringify({ name, version, redirectUri }) }),
    oauthStatus: (name, version) =>
      req(base, `/mcp/oauth/status?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`),
    oauthRefresh: (name, version) =>
      req(base, '/mcp/oauth/refresh', { method: 'POST', body: JSON.stringify({ name, version }) }),
    getServerMode: () => req(base, '/mcp/server-mode'),
    setServerMode: (enabled) =>
      req(base, '/mcp/server-mode', { method: 'POST', body: JSON.stringify({ enabled }) }),
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
 * a pre-call gate check demo, remote (sse/http) connect, OAuth login,
 * and the MCP server-mode kill switch.
 */
export function McpPanel(props: { mcp?: McpApi }) {
  const { t } = useLang();
  const [api] = useState<McpApi>(() => props.mcp ?? createMcpApi());
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gateResult, setGateResult] = useState<{ allowed: boolean; reason: string } | null>(null);
  const [rName, setRName] = useState('playwright');
  const [rVersion, setRVersion] = useState('1.0.0');
  const [rTransport, setRTransport] = useState('stdio');
  const [rUrl, setRUrl] = useState('');
  const [rClientId, setRClientId] = useState('');
  const [rIssuer, setRIssuer] = useState('');
  const [gServer, setGServer] = useState('github');
  const [gTool, setGTool] = useState('get_file_contents');
  const [serverMode, setServerModeState] = useState<boolean | null>(null);
  const [oauthState, setOauthState] = useState<Record<string, McpOAuthStatus>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { servers: s } = await api.list();
      setServers(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  const refreshServerMode = useCallback(async () => {
    try {
      const m = await api.getServerMode();
      setServerModeState(m.enabled);
    } catch {
      setServerModeState(null);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshServerMode(); }, [refreshServerMode]);

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
    run(() => {
      const def: Record<string, unknown> = {
        name: rName,
        version: rVersion,
        provider: 'community',
        transport: rTransport,
      };
      if (rTransport === 'http') {
        def.runtimePolicy = { serverUrl: rUrl.trim() };
      }
      if (rClientId.trim()) {
        def.oauth = {
          clientId: rClientId.trim(),
          ...(rIssuer.trim() ? { issuer: rIssuer.trim() } : {}),
          scopes: [],
        };
      }
      return api.register(def);
    });

  const doGate = () =>
    run(async () => {
      const v = await api.gate(gServer, gTool);
      setGateResult(v);
    });

  const doConnect = (s: McpServerSummary) =>
    run(async () => {
      try {
        const r = await api.remoteConnect(s.name, s.version);
        const n = r.tools?.length ?? 0;
        setNotice(t('mcp.connectedTools', { n: String(n) }));
      } catch (e) {
        throw new Error(t('mcp.connectFailed', { message: (e as Error).message }));
      }
    });

  const loadOauthStatus = async (s: McpServerSummary) => {
    try {
      const st = await api.oauthStatus(s.name, s.version);
      setOauthState((prev) => ({ ...prev, [`${s.name}@${s.version}`]: st }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doOauthLogin = (s: McpServerSummary) =>
    run(async () => {
      const redirectUri = `${window.location.origin}/api/mcp/oauth/callback`;
      const { authorizationUrl } = await api.oauthStart(s.name, s.version, redirectUri);
      window.open(authorizationUrl, '_blank', 'noopener');
      setNotice(t('mcp.oauthOpened'));
      await loadOauthStatus(s);
    });

  const doOauthRefresh = (s: McpServerSummary) =>
    run(async () => {
      await api.oauthRefresh(s.name, s.version);
      await loadOauthStatus(s);
    });

  const doToggleServerMode = () =>
    run(async () => {
      const next = !(serverMode ?? false);
      const m = await api.setServerMode(next);
      setServerModeState(m.enabled);
    });

  const isRemote = (s: McpServerSummary) => s.transport === 'http';
  /** legacy rows persisted before HTTP+SSE was deprecated (2026-07-28) */
  const isDeprecatedTransport = (s: McpServerSummary) => s.transport === 'sse';

  return (
    <div className="mcp-panel">
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      <h4 style={{ margin: '4px 0' }}>{t('mcp.servers')} <span className="muted">({servers.length})</span></h4>
      {servers.length === 0 && <div className="muted">{t('mcp.noServers')}</div>}
      <ul className="ev-list">
        {servers.map((s) => {
          const key = `${s.name}@${s.version}`;
          const ost = oauthState[key];
          return (
            <li key={key} style={{ marginBottom: 6 }}>
              <span className={`status-dot ${statusClass(s.installStatus)}`} style={{ display: 'inline-block', marginRight: 6 }} />
              <b>{s.name}@{s.version}</b>{' '}
              <span className="muted">{s.provider} · {s.transport} · {t('mcp.toolsLabel', { tools: s.tools.join(', ') || '—' })}</span>{' '}
              <span className="pill">{s.trustLevel}</span>{' '}
              <span className="pill">{s.approvalPolicy}</span>{' '}
              <span className="pill">{s.installStatus}</span>{' '}
              {!s.enabled && <span className="pill">{t('mcp.disabled')}</span>}
              {s.negotiatedVersion && <span className="pill">{s.negotiatedVersion}</span>}
              {isRemote(s) && (
                <span className="pill">{s.connected ? t('mcp.connected') : t('mcp.notConnected')}</span>
              )}
              {isDeprecatedTransport(s) && <span className="pill">{t('mcp.deprecatedTransport')}</span>}
              <span style={{ marginLeft: 8 }}>
                <button disabled={busy} onClick={() => run(() => api.install(s.name, s.version))}>{t('mcp.install')}</button>{' '}
                {isRemote(s) && (
                  <>
                    <button disabled={busy} onClick={() => doConnect(s)}>{t('mcp.connect')}</button>{' '}
                  </>
                )}
                {s.oauthConfigured && (
                  <>
                    <button disabled={busy} onClick={() => doOauthLogin(s)}>{t('mcp.oauthLogin')}</button>{' '}
                    <button disabled={busy} onClick={() => doOauthRefresh(s)}>{t('mcp.oauthRefresh')}</button>{' '}
                  </>
                )}
                {s.installStatus === 'PENDING_REVIEW' && (
                  <>
                    <button disabled={busy} onClick={() => run(() => api.review(s.name, s.version, true))}>{t('mcp.approve')}</button>{' '}
                    <button disabled={busy} onClick={() => run(() => api.review(s.name, s.version, false))}>{t('mcp.reject')}</button>{' '}
                  </>
                )}
                <button disabled={busy} onClick={() => { if (window.confirm(t('mcp.confirmRemove', { name: s.name, version: s.version }))) run(() => api.remove(s.name, s.version)); }}>{t('mcp.remove')}</button>
              </span>
              {s.oauthConfigured && ost && (
                <div className="muted" style={{ marginTop: 2 }}>
                  {ost.hasToken ? (ost.expired ? t('mcp.oauthTokenExpired') : t('mcp.oauthTokenOk')) : t('mcp.oauthNoToken')}
                  {ost.scopes ? ` · ${ost.scopes}` : ''}
                </div>
              )}
              {isRemote(s) && s.serverUrl && (
                <div className="muted" style={{ marginTop: 2 }}>{t('mcp.serverUrl')}: {s.serverUrl}</div>
              )}
            </li>
          );
        })}
      </ul>
      <h4 style={{ margin: '12px 0 4px' }}>{t('mcp.registerNew')}</h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input value={rName} onChange={(e) => setRName(e.target.value)} placeholder={t('mcp.namePlaceholder')} />
        <input value={rVersion} onChange={(e) => setRVersion(e.target.value)} placeholder={t('mcp.versionPlaceholder')} />
        <select value={rTransport} onChange={(e) => setRTransport(e.target.value)} aria-label={t('mcp.transport')}>
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
        {rTransport === 'http' && (
          <input
            value={rUrl}
            onChange={(e) => setRUrl(e.target.value)}
            placeholder={t('mcp.serverUrlPlaceholder')}
            style={{ minWidth: 280 }}
          />
        )}
        <button disabled={busy} onClick={doRegister}>{t('mcp.register')}</button>
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>{t('mcp.oauthSection')}</h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input value={rClientId} onChange={(e) => setRClientId(e.target.value)} placeholder={t('mcp.clientIdPlaceholder')} />
        <input
          value={rIssuer}
          onChange={(e) => setRIssuer(e.target.value)}
          placeholder={t('mcp.issuerPlaceholder')}
          style={{ minWidth: 280 }}
        />
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>{t('mcp.serverMode')}</h4>
      <div className="muted" style={{ marginBottom: 6 }}>{t('mcp.serverModeDesc')}</div>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span className={`status-dot ${serverMode ? 'st-active' : 'st-idle'}`} style={{ display: 'inline-block' }} />
        <button disabled={busy || serverMode === null} onClick={doToggleServerMode}>
          {serverMode ? t('mcp.disable') : t('mcp.enable')}
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 4 }}>{t('mcp.serverModeCommand')}</div>
      <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>
        {`{ "command": ["node", "<ai-factory>/apps/server/dist/mcp-serve.js"],
  "env": { "PORT": "3100", "AI_FACTORY_TOKEN": "<token>" } }`}
      </pre>
      <div className="muted">{t('mcp.serverModeHint')}</div>
      <h4 style={{ margin: '12px 0 4px' }}>{t('mcp.gateCheck')} <span className="muted">(§73)</span></h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={gServer} onChange={(e) => setGServer(e.target.value)} placeholder="server" />
        <input value={gTool} onChange={(e) => setGTool(e.target.value)} placeholder="tool" />
        <button disabled={busy} onClick={doGate}>{t('mcp.checkGate')}</button>
      </div>
      {gateResult && (
        <div className={`banner ${gateResult.allowed ? '' : 'err'}`}>
          {gateResult.allowed ? t('mcp.allowed') : t('mcp.denied')} — {gateResult.reason}
        </div>
      )}
    </div>
  );
}
