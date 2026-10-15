import { useEffect, useState } from 'react';
import { api, AuditRecord } from '../api';

const TABS = ['AI Activity', 'Terminal', 'Tests', 'Logs', 'Evidence'] as const;

/** §3 bottom panel. AI Activity streams the immutable audit log (§70). */
export function BottomPanel() {
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
        if (!silent) setErr(null);
      }).catch((e) => {
        if (cancelled) return;
        if (!silent) setErr(e instanceof Error ? e.message : String(e));
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
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="bottom-body">
        {tab === 'AI Activity' && (
          <div className="activity">
            {err && <span className="pill warn">审计日志加载失败：{err}</span>}
            {!err && loading && records.length === 0 && <span className="muted">加载中…</span>}
            {!err && !loading && records.length === 0 && <span className="muted">No activity yet.</span>}
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
        {tab === 'Tests' && <div className="muted">Test runs will appear here. <span className="pill">stub</span></div>}
        {tab === 'Logs' && <div className="muted">Run logs stream here. <span className="pill">stub</span></div>}
        {tab === 'Evidence' && <div className="muted">Select a task card to inspect its evidence chain (§42).</div>}
      </div>
    </footer>
  );
}
