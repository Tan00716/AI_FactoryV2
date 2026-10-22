import { useCallback, useState } from 'react';
import { api, type HttpRunResponse } from '../api';
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
    </div>
  );
}
