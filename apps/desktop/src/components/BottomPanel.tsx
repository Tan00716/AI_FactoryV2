import { useEffect, useState } from 'react';
import { api, AuditRecord } from '../api';

const TABS = ['AI Activity', 'Terminal', 'Tests', 'Logs', 'Evidence'] as const;

/** §3 bottom panel. AI Activity streams the immutable audit log (§70). */
export function BottomPanel() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('AI Activity');
  const [records, setRecords] = useState<AuditRecord[]>([]);

  useEffect(() => {
    if (tab !== 'AI Activity') return;
    api.audit(50).then(setRecords).catch(() => setRecords([]));
    const t = setInterval(() => {
      api.audit(50).then(setRecords).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
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
            {records.length === 0 && <span className="muted">No activity yet.</span>}
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
