import { useCallback, useEffect, useState } from 'react';
import { api, type DiagnosticsBundleView, type DiagnosticsPreview } from '../api';
import { useLang } from '../i18n';

/**
 * Diagnostics bundle export (V3-#10) — user-initiated, never automatic.
 *
 * Flow: preview list (what the bundle would contain, and what it never
 * contains) -> explicit confirm -> bundle returned to the caller, who
 * downloads it as JSON (+ the HTML report string as a second file).
 * The panel never uploads anything anywhere.
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 * - The bundle contains counts and stripped fields only: audit details
 *   payloads, task titles, file contents, and environment variables are
 *   never included, in any form.
 * - Free text inside the bundle is redacted with the shared secret
 *   patterns, and the server refuses the export (409) if its self-check
 *   still finds a pattern — a refused export ships nothing.
 * - The error excerpt is heuristic: the audit log has no severity
 *   column, so "failure-shaped" means a non-ok result or a
 *   BLOCKED/FAILED/DENIED action name.
 * - The model-egress notice is a placeholder until a real model is
 *   connected; it is shown again before each call once one is.
 */
export function DiagnosticsPanel() {
  const { t, lang } = useLang();
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [bundle, setBundle] = useState<DiagnosticsBundleView | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setPreview(await api.diagnosticsPreview());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const exportBundle = async () => {
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      const res = await api.diagnosticsExport();
      setBundle(res.bundle);
      setMsg(t('diagnostics.exported', { id: res.bundle.meta.bundleId }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const download = (name: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2>{t('diagnostics.title')}</h2>
      <p className="muted">{t('diagnostics.desc')}</p>
      {loading && <p>{t('diagnostics.loading')}</p>}
      {err && <p className="err">{err}</p>}
      {msg && <p>{msg}</p>}
      {preview && (
        <>
          <h3>{t('diagnostics.preview')}</h3>
          <p>{lang === 'zh' ? preview.noticeZh : preview.noticeEn}</p>
          <h4>{t('diagnostics.includes')}</h4>
          <ul>
            {preview.includes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <h4>{t('diagnostics.excludes')}</h4>
          <ul>
            {preview.excludes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <h4>{t('diagnostics.sections')}</h4>
          <ul>
            {preview.estimatedSections.map((s) => (
              <li key={s.section}>
                {s.section}: {s.detail}
              </li>
            ))}
          </ul>
          <button onClick={exportBundle} disabled={loading}>
            {t('diagnostics.export')}
          </button>{' '}
          <button onClick={refresh} disabled={loading}>
            {t('diagnostics.refresh')}
          </button>
        </>
      )}
      {bundle && (
        <>
          <h3>{t('diagnostics.result')}</h3>
          <p>
            {t('diagnostics.bundleId')}: {bundle.meta.bundleId} · {bundle.meta.appVersion} / {bundle.meta.serverVersion} ·{' '}
            {bundle.meta.platform}-{bundle.meta.arch} · {t('diagnostics.auditRecords', { n: bundle.auditSummary.totalRecords })} ·{' '}
            {t('diagnostics.tasks', { n: bundle.taskEvidence.taskCount })} · {t('diagnostics.authMode')}: {bundle.configSnapshot.authMode} ·{' '}
            {t('diagnostics.perf')}: {bundle.perfBaseline.available ? t('diagnostics.perfYes') : t('diagnostics.perfNo')}
          </p>
          <button
            onClick={() =>
              download(`diagnostics-${bundle.meta.bundleId}.json`, JSON.stringify(bundle, null, 2), 'application/json')
            }
          >
            {t('diagnostics.downloadJson')}
          </button>{' '}
          <button onClick={() => download(`diagnostics-${bundle.meta.bundleId}.html`, bundle.reportHtml, 'text/html')}>
            {t('diagnostics.downloadHtml')}
          </button>
        </>
      )}
      <p className="muted">{t('diagnostics.boundary')}</p>
    </div>
  );
}
