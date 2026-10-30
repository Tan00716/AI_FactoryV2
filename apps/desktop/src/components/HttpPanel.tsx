import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ApiAuthProfileView,
  type ApiCollectionView,
  type ApiEnvironmentView,
  type ApiHistoryView,
  type ApiWsSessionView,
  type HttpRunResponse,
  type HttpRunResultView,
} from '../api';
import { useLang } from '../i18n';

/**
 * HTTP/REST debug client panel (round-4 task A6) — JetBrains HTTP Client style.
 *
 * Flow: paste/edit a .http file → pick an environment (optional) → Run →
 * per-request status, duration, response body preview and assertion results.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Every request URL passes the egress firewall before anything is dialed;
 *    a refused URL shows as blocked (nothing left the host).
 *  - Redirects are NOT followed; a 3xx is reported as-is.
 *  - Response bodies are capped at 5MB in the sender.
 */
const SAMPLE = `### health probe
GET {{baseUrl}}/api/health

> status == 200
> header content-type contains json
> max-time-ms 2000

### json check
GET {{baseUrl}}/api/health
> status in 2xx
> json-path $.ok == true
`;

export function HttpPanel() {
  const { t } = useLang();
  const [text, setText] = useState(SAMPLE);
  const [environment, setEnvironment] = useState('');
  const [environmentsJson, setEnvironmentsJson] = useState(
    '{\n  "local": { "vars": { "baseUrl": "http://127.0.0.1:3100" } }\n}',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HttpRunResponse | null>(null);
  const [openBody, setOpenBody] = useState<Record<string, boolean>>({});
  // R7-#9 deepening: sub-tabs inside the existing HTTP panel (no new
  // center tab, so e2e tab indexing is unchanged).
  const [mode, setMode] = useState<'file' | 'collections' | 'graphql' | 'ws' | 'history'>('file');
  const [collections, setCollections] = useState<ApiCollectionView[]>([]);
  const [authProfiles, setAuthProfiles] = useState<ApiAuthProfileView[]>([]);
  const [apiEnvs, setApiEnvs] = useState<ApiEnvironmentView[]>([]);
  const [history, setHistory] = useState<ApiHistoryView[]>([]);
  const [wsSessions, setWsSessions] = useState<ApiWsSessionView[]>([]);
  const [deepError, setDeepError] = useState<string | null>(null);

  const refreshDeep = useCallback(async () => {
    try {
      const [c, a, e, h, w] = await Promise.all([
        api.apiCollections(),
        api.apiAuthProfiles(),
        api.apiEnvironments(),
        api.apiHistory(),
        api.apiWsSessions(),
      ]);
      setCollections(c.collections);
      setAuthProfiles(a.profiles);
      setApiEnvs(e.environments);
      setHistory(h.history);
      setWsSessions(w.sessions);
      setDeepError(null);
    } catch (e2) {
      setDeepError((e2 as Error).message);
    }
  }, []);

  useEffect(() => {
    if (mode !== 'file') void refreshDeep();
  }, [mode, refreshDeep]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let environments: Record<string, { vars: Record<string, string> }> | undefined;
      const raw = environmentsJson.trim();
      if (raw) environments = JSON.parse(raw);
      const r = await api.httpRun({
        text,
        environment: environment.trim() || undefined,
        environments,
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [text, environment, environmentsJson]);

  return (
    <div className="http-panel">
      <h2>{t('http.title')}</h2>
      <p className="http-boundaries">{t('http.boundaries')}</p>
      <div className="http-modes">
        {(['file', 'collections', 'graphql', 'ws', 'history'] as const).map((m) => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {t(`apiclient.tab${m === 'file' ? 'File' : m === 'collections' ? 'Collections' : m === 'graphql' ? 'Graphql' : m === 'ws' ? 'Ws' : 'History'}`)}
          </button>
        ))}
        <button onClick={() => void refreshDeep()}>{t('apiclient.refresh')}</button>
      </div>
      {mode !== 'file' && <p className="http-boundaries">{t('apiclient.boundaries2')}</p>}
      {deepError && mode !== 'file' && <div className="http-error">{deepError}</div>}
      {mode === 'file' && (
      <div className="http-grid">
        <div className="http-left">
          <label>
            {t('http.fileLabel')}
            <textarea
              className="http-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={18}
            />
          </label>
          <label>
            {t('http.envJsonLabel')}
            <textarea
              className="http-textarea http-env"
              value={environmentsJson}
              onChange={(e) => setEnvironmentsJson(e.target.value)}
              spellCheck={false}
              rows={6}
            />
          </label>
          <div className="http-controls">
            <label>
              {t('http.environment')}
              <input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder={t('http.environmentPlaceholder')}
              />
            </label>
            <button onClick={run} disabled={busy}>
              {busy ? t('http.running') : t('http.run')}
            </button>
          </div>
          {error && <div className="http-error">{error}</div>}
        </div>
        <div className="http-right">
          {!result && <div className="http-empty">{t('http.noResult')}</div>}
          {result?.results.map((r) => (
            <div key={r.id} className={`http-result ${r.ok ? 'ok' : 'fail'}`}>
              <div className="http-result-head">
                <span className="http-method">{r.method}</span>
                <span className="http-url" title={r.url}>{r.url}</span>
                {r.blocked ? (
                  <span className="http-status blocked">{t('http.blocked')}</span>
                ) : (
                  <span className="http-status">{r.status ?? '—'}</span>
                )}
                {r.durationMs !== undefined && <span className="http-time">{Math.round(r.durationMs)}ms</span>}
                <span className="http-ok">{r.ok ? t('http.pass') : t('http.fail')}</span>
                {r.name && <span className="http-name">{r.name}</span>}
              </div>
              {r.blocked && <div className="http-blocked-reason">{r.blockedReason}</div>}
              {r.error && <div className="http-error">{r.error}</div>}
              <ul className="http-assertions">
                {r.assertions.map((a, i) => (
                  <li key={i} className={a.passed ? 'pass' : 'fail'}>
                    {a.passed ? '✓' : '✗'} {a.detail}
                  </li>
                ))}
              </ul>
              {r.bodyText !== undefined && (
                <div>
                  <button
                    className="http-toggle"
                    onClick={() => setOpenBody((s) => ({ ...s, [r.id]: !s[r.id] }))}
                  >
                    {t('http.body')} ({(r.bytes ?? r.bodyText.length)} bytes)
                  </button>
                  {openBody[r.id] && <pre className="http-body">{r.bodyText.slice(0, 4000)}</pre>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
      {mode === 'collections' && (
        <CollectionsSection
          collections={collections}
          authProfiles={authProfiles}
          apiEnvs={apiEnvs}
          onRefresh={refreshDeep}
        />
      )}
      {mode === 'graphql' && <GraphqlSection authProfiles={authProfiles} apiEnvs={apiEnvs} />}
      {mode === 'ws' && <WsSection sessions={wsSessions} onRefresh={refreshDeep} />}
      {mode === 'history' && <HistorySection history={history} onRefresh={refreshDeep} />}
    </div>
  );
}

function parseJsonObject(text: string): Record<string, string> {
  const raw = text.trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected a JSON object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error('header values must be strings');
    out[k] = v;
  }
  return out;
}

function CollectionsSection(props: {
  collections: ApiCollectionView[];
  authProfiles: ApiAuthProfileView[];
  apiEnvs: ApiEnvironmentView[];
  onRefresh: () => void;
}) {
  const { t } = useLang();
  const { collections, authProfiles, apiEnvs, onRefresh } = props;
  const [colId, setColId] = useState('');
  const [colName, setColName] = useState('');
  const [reqName, setReqName] = useState('');
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('{{baseUrl}}/api/health');
  const [headersJson, setHeadersJson] = useState('{}');
  const [body, setBody] = useState('');
  const [environment, setEnvironment] = useState('');
  const [authProfileId, setAuthProfileId] = useState('');
  const [targetCol, setTargetCol] = useState('');
  const [sendResult, setSendResult] = useState<HttpRunResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Auth profile + environment forms.
  const [authId, setAuthId] = useState('');
  const [authName, setAuthName] = useState('');
  const [authKind, setAuthKind] = useState('bearer');
  const [authUsername, setAuthUsername] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('X-Api-Key');
  const [authSecret, setAuthSecret] = useState('');
  const [authSecretEnv, setAuthSecretEnv] = useState('');
  const [envName, setEnvName] = useState('');
  const [envVarsJson, setEnvVarsJson] = useState('{\n  "baseUrl": "http://127.0.0.1:3100"\n}');
  const [envSecretNames, setEnvSecretNames] = useState('');
  const [envSecretsJson, setEnvSecretsJson] = useState('{}');

  const createCollection = async () => {
    setError(null);
    try {
      await api.apiCreateCollection({ id: colId.trim(), name: colName.trim() || colId.trim(), requests: [] });
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addRequest = async () => {
    setError(null);
    try {
      const col = collections.find((c) => c.id === targetCol);
      if (!col) throw new Error('pick a collection first');
      const headers = parseJsonObject(headersJson);
      const req = {
        id: `r${Date.now()}`,
        name: reqName.trim() || 'request',
        method,
        url: url.trim(),
        headers,
        ...(body ? { body } : {}),
        authProfileId: authProfileId || null,
        environment: environment || null,
      };
      await api.apiUpdateCollection({ ...col, requests: [...col.requests, req] });
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sendSaved = async (col: ApiCollectionView, reqId: string) => {
    setError(null);
    setBusy(true);
    try {
      const saved = col.requests.find((r) => r.id === reqId);
      if (!saved) throw new Error('request not found');
      const r = await api.apiSend({
        method: saved.method,
        url: saved.url,
        headers: saved.headers,
        body: saved.body,
        environment: saved.environment ?? undefined,
        authProfileId: saved.authProfileId ?? undefined,
        collectionId: col.id,
        requestName: saved.name,
      });
      setSendResult(r.result);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createAuth = async () => {
    setError(null);
    try {
      await api.apiCreateAuthProfile(
        {
          id: authId.trim(),
          name: authName.trim() || authId.trim(),
          kind: authKind,
          ...(authKind === 'basic' ? { username: authUsername.trim() } : {}),
          ...(authKind === 'apikey' ? { headerName: authHeaderName.trim() || 'X-Api-Key' } : {}),
          ...(authSecretEnv.trim() ? { secretEnv: authSecretEnv.trim() } : {}),
        },
        authSecret || undefined,
      );
      setAuthSecret('');
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveEnv = async () => {
    setError(null);
    try {
      const vars = parseJsonObject(envVarsJson);
      const secretNames = envSecretNames.split(',').map((s) => s.trim()).filter(Boolean);
      const secrets = JSON.parse(envSecretsJson.trim() || '{}') as Record<string, string>;
      await api.apiSaveApiEnvironment({ name: envName.trim(), vars, secretNames }, secrets);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="http-deep">
      <h3>{t('apiclient.collectionsTitle')}</h3>
      <div className="http-controls">
        <label>{t('apiclient.collectionId')}<input value={colId} onChange={(e) => setColId(e.target.value)} /></label>
        <label>{t('apiclient.collectionName')}<input value={colName} onChange={(e) => setColName(e.target.value)} /></label>
        <button onClick={() => void createCollection()}>{t('apiclient.newCollection')}</button>
      </div>
      {collections.map((col) => (
        <div key={col.id} className="http-result">
          <div className="http-result-head">
            <span>{col.name} ({col.id})</span>
            <button onClick={() => void api.apiDeleteCollection(col.id).then(onRefresh)}>{t('apiclient.delete')}</button>
          </div>
          {col.requests.map((r) => (
            <div key={r.id}>
              <span className="http-method">{r.method}</span> {r.name} — {r.url}
              <button disabled={busy} onClick={() => void sendSaved(col, r.id)}>{t('apiclient.send')}</button>
            </div>
          ))}
        </div>
      ))}
      <h3>{t('apiclient.addRequest')}</h3>
      <div className="http-controls">
        <label>{t('apiclient.collectionsTitle')}
          <select value={targetCol} onChange={(e) => setTargetCol(e.target.value)}>
            <option value="">—</option>
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>{t('apiclient.requestName')}<input value={reqName} onChange={(e) => setReqName(e.target.value)} /></label>
        <label>{t('apiclient.method')}
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label>{t('apiclient.urlTemplate')}<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label>{t('apiclient.headersJson')}<input value={headersJson} onChange={(e) => setHeadersJson(e.target.value)} /></label>
        <label>{t('apiclient.environment')}
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="">—</option>
            {apiEnvs.map((e2) => <option key={e2.name} value={e2.name}>{e2.name}</option>)}
          </select>
        </label>
        <label>{t('apiclient.authProfile')}
          <select value={authProfileId} onChange={(e) => setAuthProfileId(e.target.value)}>
            <option value="">{t('apiclient.noAuth')}</option>
            {authProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>)}
          </select>
        </label>
      </div>
      <label>{t('apiclient.bodyText')}<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} spellCheck={false} /></label>
      <button onClick={() => void addRequest()}>{t('apiclient.addRequest')}</button>
      {sendResult && (
        <div className={`http-result ${sendResult.ok ? 'ok' : 'fail'}`}>
          <span>{sendResult.status ?? '—'}</span> {sendResult.url}
          {sendResult.error && <div className="http-error">{sendResult.error}</div>}
          {sendResult.bodyText !== undefined && <pre className="http-body">{sendResult.bodyText.slice(0, 4000)}</pre>}
        </div>
      )}
      <h3>{t('apiclient.authTitle')}</h3>
      <div className="http-controls">
        <label>{t('apiclient.collectionId')}<input value={authId} onChange={(e) => setAuthId(e.target.value)} /></label>
        <label>{t('apiclient.collectionName')}<input value={authName} onChange={(e) => setAuthName(e.target.value)} /></label>
        <label>{t('apiclient.authKind')}
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value)}>
            <option value="bearer">bearer</option>
            <option value="basic">basic</option>
            <option value="apikey">apikey</option>
            <option value="oauth2">oauth2 (placeholder)</option>
          </select>
        </label>
        {authKind === 'basic' && <label>{t('apiclient.authUsername')}<input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} /></label>}
        {authKind === 'apikey' && <label>{t('apiclient.authHeaderName')}<input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} /></label>}
        <label>{t('apiclient.authSecret')}<input type="password" value={authSecret} onChange={(e) => setAuthSecret(e.target.value)} /></label>
        <label>{t('apiclient.authSecretEnv')}<input value={authSecretEnv} onChange={(e) => setAuthSecretEnv(e.target.value)} /></label>
        <button onClick={() => void createAuth()}>{t('apiclient.authCreate')}</button>
      </div>
      {authProfiles.map((p) => (
        <div key={p.id}>
          {p.name} ({p.kind}) — {p.hasSecret ? t('apiclient.hasSecret') : t('apiclient.noSecret')}
          {p.secretSource === 'env' ? ` (${p.secretEnv})` : ''}
          <button onClick={() => void api.apiDeleteAuthProfile(p.id).then(onRefresh)}>{t('apiclient.delete')}</button>
        </div>
      ))}
      <h3>{t('apiclient.envTitle')}</h3>
      <div className="http-controls">
        <label>{t('apiclient.envName')}<input value={envName} onChange={(e) => setEnvName(e.target.value)} /></label>
        <label>{t('apiclient.envSecretNames')}<input value={envSecretNames} onChange={(e) => setEnvSecretNames(e.target.value)} /></label>
      </div>
      <label>{t('apiclient.envVarsJson')}<textarea value={envVarsJson} onChange={(e) => setEnvVarsJson(e.target.value)} rows={4} spellCheck={false} /></label>
      <label>{t('apiclient.envSecretsJson')}<textarea value={envSecretsJson} onChange={(e) => setEnvSecretsJson(e.target.value)} rows={2} spellCheck={false} /></label>
      <button onClick={() => void saveEnv()}>{t('apiclient.envSave')}</button>
      {apiEnvs.map((e2) => (
        <div key={e2.name}>{e2.name}: {Object.entries(e2.vars).map(([k, v]) => `${k}=${v}`).join(', ')}</div>
      ))}
      {error && <div className="http-error">{error}</div>}
    </div>
  );
}

function GraphqlSection(props: { authProfiles: ApiAuthProfileView[]; apiEnvs: ApiEnvironmentView[] }) {
  const { t } = useLang();
  const { authProfiles, apiEnvs } = props;
  const [endpoint, setEndpoint] = useState('{{baseUrl}}/graphql');
  const [query, setQuery] = useState('{ user { id } }');
  const [variablesJson, setVariablesJson] = useState('{}');
  const [environment, setEnvironment] = useState('');
  const [authProfileId, setAuthProfileId] = useState('');
  const [result, setResult] = useState<(HttpRunResultView & { graphqlErrors?: Array<{ message: string }> }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const variables = JSON.parse(variablesJson.trim() || '{}') as Record<string, unknown>;
      const r = await api.apiGraphql({
        endpoint: endpoint.trim(),
        query,
        variables,
        environment: environment || undefined,
        authProfileId: authProfileId || undefined,
      });
      setResult(r.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="http-deep">
      <label>{t('apiclient.gqlEndpoint')}<input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></label>
      <label>{t('apiclient.gqlQuery')}<textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={6} spellCheck={false} /></label>
      <label>{t('apiclient.gqlVariablesJson')}<textarea value={variablesJson} onChange={(e) => setVariablesJson(e.target.value)} rows={3} spellCheck={false} /></label>
      <div className="http-controls">
        <label>{t('apiclient.environment')}
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="">—</option>
            {apiEnvs.map((e2) => <option key={e2.name} value={e2.name}>{e2.name}</option>)}
          </select>
        </label>
        <label>{t('apiclient.authProfile')}
          <select value={authProfileId} onChange={(e) => setAuthProfileId(e.target.value)}>
            <option value="">{t('apiclient.noAuth')}</option>
            {authProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>)}
          </select>
        </label>
        <button disabled={busy} onClick={() => void run()}>{t('apiclient.gqlRun')}</button>
      </div>
      {error && <div className="http-error">{error}</div>}
      {result && (
        <div className={`http-result ${result.ok ? 'ok' : 'fail'}`}>
          <span>{result.status ?? '—'}</span>
          {result.graphqlErrors && result.graphqlErrors.length > 0 && (
            <div>{t('apiclient.gqlErrors')}: {result.graphqlErrors.map((g) => g.message).join('; ')}</div>
          )}
          {result.bodyText !== undefined && <pre className="http-body">{result.bodyText.slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  );
}

function WsSection(props: { sessions: ApiWsSessionView[]; onRefresh: () => void }) {
  const { t } = useLang();
  const { sessions, onRefresh } = props;
  const [url, setUrl] = useState('ws://127.0.0.1:3100/ws');
  const [text, setText] = useState('hello');
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<Array<{ direction: 'in' | 'out'; text: string; at: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshMessages = async (id: string) => {
    try {
      const r = await api.apiWsMessages(id);
      setMessages(r.messages);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="http-deep">
      <p className="http-boundaries">{t('apiclient.wsEgressNote')}</p>
      <div className="http-controls">
        <label>{t('apiclient.wsUrl')}<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <button onClick={() => void api.apiWsConnect(url.trim()).then((r) => { setSelected(r.session.id); onRefresh(); }).catch((e) => setError((e as Error).message))}>{t('apiclient.wsConnect')}</button>
      </div>
      <div className="http-controls">
        <label>{t('apiclient.wsUrl')}
          <select value={selected} onChange={(e) => { setSelected(e.target.value); if (e.target.value) void refreshMessages(e.target.value); }}>
            <option value="">—</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.url} ({s.status})</option>)}
          </select>
        </label>
        <label>{t('apiclient.wsMessage')}<input value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button disabled={!selected} onClick={() => void api.apiWsSend(selected, text).then(() => refreshMessages(selected)).catch((e) => setError((e as Error).message))}>{t('apiclient.wsSend')}</button>
        <button disabled={!selected} onClick={() => void api.apiWsClose(selected).then(onRefresh).catch((e) => setError((e as Error).message))}>{t('apiclient.wsClose')}</button>
        <button disabled={!selected} onClick={() => void refreshMessages(selected)}>{t('apiclient.refresh')}</button>
      </div>
      {messages.map((m, i) => (
        <div key={i}>{m.direction === 'in' ? '←' : '→'} {m.text}</div>
      ))}
      {error && <div className="http-error">{error}</div>}
    </div>
  );
}

function HistorySection(props: { history: ApiHistoryView[]; onRefresh: () => void }) {
  const { t } = useLang();
  const { history, onRefresh } = props;
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<HttpRunResultView | null>(null);

  if (history.length === 0) return <div className="http-deep">{t('apiclient.histEmpty')}</div>;
  return (
    <div className="http-deep">
      {history.map((h) => (
        <div key={h.id} className={`http-result ${h.ok ? 'ok' : 'fail'}`}>
          <span className="http-method">{h.method}</span> {h.requestName || '—'} — {h.urlTemplate}
          <span>{h.status ?? (h.blocked ? t('http.blocked') : '—')}</span>
          {h.rerunOf && <span>rerun of {h.rerunOf.slice(0, 8)}</span>}
          <button onClick={() => void api.apiRerunHistory(h.id).then((r) => { setLastResult(r.result); onRefresh(); }).catch((e) => setError((e as Error).message))}>{t('apiclient.histRerun')}</button>
        </div>
      ))}
      {error && <div className="http-error">{error}</div>}
      {lastResult && lastResult.bodyText !== undefined && <pre className="http-body">{lastResult.bodyText.slice(0, 4000)}</pre>}
    </div>
  );
}
