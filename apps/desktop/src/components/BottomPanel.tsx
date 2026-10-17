import { useEffect, useState } from 'react';
import { api, AuditRecord } from '../api';
import { useLang } from '../i18n';

const TABS = ['AI Activity', 'Terminal', 'Tests', 'Logs', 'Evidence'] as const;

/** Tab 标题 i18n：内部标识保持英文原值，展示层翻译。 */
const TAB_TITLE_KEYS: Record<string, string> = {
  'AI Activity': 'bottom.tab.activity',
  Terminal: 'bottom.tab.terminal',
  Tests: 'bottom.tab.tests',
  Logs: 'bottom.tab.logs',
  Evidence: 'bottom.tab.evidence',
};

/** §3 bottom panel. AI Activity streams the immutable audit log (§70). */
export function BottomPanel() {
  const { t } = useLang();
  const tabTitle = (name: string): string => t(TAB_TITLE_KEYS[name] ?? name);
  const [tab, setTab] = useState<(typeof TABS)[number]>('AI Activity');
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'AI Activity') return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const load = (silent: boolean) => {
      api.audit(50).then((rs) => {
        if (cancelled) return;
        setRecords(rs);
        // Always clear on success: a transient failure (e.g. the backend not
        // yet listening when the packaged app boots) must not leave a stale
        // pill behind once rows start streaming in on the 5s silent polls.
        setErr(null);
      }).catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }).finally(() => {
        if (!silent && !cancelled) setLoading(false);
      });
    };
    load(false);
    const t = setInterval(() => load(true), 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [tab]);

  return (
    <footer className="bottom">
      <div className="bottom-tabs">
        {TABS.map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{tabTitle(name)}</button>
        ))}
      </div>
      <div className="bottom-body">
        {tab === 'AI Activity' && (
          <div className="activity">
            {err && <span className="pill warn">{t('bottom.auditLoadFailed', { message: err })}</span>}
            {!err && loading && records.length === 0 && <span className="muted">{t('bottom.loading')}</span>}
            {!err && !loading && records.length === 0 && <span className="muted">{t('activity.empty')} {t('activity.emptyHint')}</span>}
            {records.map((r) => (
              <div key={r.id} className="act-row">
                <span className="muted">{new Date(r.ts).toLocaleTimeString()}</span>
                <b>{r.actor}</b>
                <span>{r.action}</span>
                <span className="muted">{r.entityType}:{r.entityId.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'Terminal' && (
          <div className="term">
            <div>PS C:\AIProjects\MyApp&gt; <span className="muted">integrated terminal — stub in prototype</span></div>
            <div>PS C:\AIProjects\MyApp&gt; npm test <span className="muted"># runs @ai-factory/core unit tests</span></div>
          </div>
        )}
        {tab === 'Tests' && <div className="muted">{t('bottom.testsEmpty')} <span className="pill">{t('bottom.stubBadge')}</span></div>}
        {tab === 'Logs' && <div className="muted">{t('bottom.logsEmpty')} <span className="pill">{t('bottom.stubBadge')}</span></div>}
        {tab === 'Evidence' && <div className="muted">{t('bottom.evidenceEmpty')}</div>}
      </div>
    </footer>
  );
}
