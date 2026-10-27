import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type QueueJobDetailResponse,
  type QueueJobsResponse,
  type QueueJobView,
} from '../api';
import { useLang } from '../i18n';

/**
 * Background task queue panel (round-6 task R6-S4) — parallel/queued
 * execution of tasks.json label chains. Jobs run in the background
 * under a configurable concurrency cap; a running job can be cancelled
 * (the server kills its whole process group).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Jobs are process-local: a server restart drops queued and running
 *    jobs; there is no persistence or cross-restart recovery.
 *  - Parallelism lives between jobs: within one job, chain tasks run
 *    sequentially in dependency order.
 *  - The log is a 512KB sliding window (oldest bytes dropped, flagged),
 *    not a complete transcript.
 *  - Cancel kills the POSIX process group; on Windows the fallback is
 *    a direct child kill (grandchildren may survive).
 */
function StatusPill({ status }: { status: QueueJobView['status'] }) {
  const { t } = useLang();
  const cls =
    status === 'succeeded'
      ? 'pill'
      : status === 'queued' || status === 'running'
        ? 'pill warn'
        : 'pill muted';
  return <span className={cls}>{t(`queue.status.${status}`)}</span>;
}

export function QueuePanel({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [jobs, setJobs] = useState<QueueJobView[]>([]);
  const [config, setConfig] = useState(4);
  const [counts, setCounts] = useState({ running: 0, queued: 0 });
  const [label, setLabel] = useState('');
  const [concurrencyInput, setConcurrencyInput] = useState('4');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueJobDetailResponse | null>(null);
  const [log, setLog] = useState('');
  const [logTruncated, setLogTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r: QueueJobsResponse = await api.queueJobs();
      setJobs(r.jobs);
      setConfig(r.config.maxConcurrency);
      setCounts({ running: r.running, queued: r.queued });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const openJob = useCallback(async (id: string) => {
    setSelected(id);
    try {
      const d = await api.queueJob(id);
      setDetail(d);
      const l = await api.queueLog(id);
      setLog(l.log);
      setLogTruncated(l.truncated);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Refresh the open job's detail/log while it is still active.
  useEffect(() => {
    if (!selected) return;
    const active = jobs.find((j) => j.id === selected);
    if (active && (active.status === 'queued' || active.status === 'running')) {
      const timer = setTimeout(() => {
        void openJob(selected);
      }, 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [jobs, selected, openJob]);

  const submit = async () => {
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.queueSubmit(name, projectId);
      setLabel('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.queueCancel(id);
      await refresh();
      if (selected === id) await openJob(id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveConcurrency = async () => {
    const n = Number(concurrencyInput);
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      setErr(t('queue.badConcurrency'));
      return;
    }
    try {
      const r = await api.queueSetConfig(n);
      setConfig(r.maxConcurrency);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('queue.labelPlaceholder')}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button onClick={() => void submit()} disabled={busy || !label.trim()}>
          {t('queue.submit')}
        </button>
        <span className="muted">
          {t('queue.counts', { running: String(counts.running), queued: String(counts.queued), cap: String(config) })}
        </span>
        <input
          value={concurrencyInput}
          onChange={(e) => setConcurrencyInput(e.target.value)}
          style={{ width: 56 }}
          title={t('queue.concurrencyTitle')}
        />
        <button onClick={() => void saveConcurrency()}>{t('queue.saveConcurrency')}</button>
        <button onClick={() => void refresh()}>{t('queue.refresh')}</button>
      </div>
      {err && <div className="warn">{err}</div>}
      {jobs.length === 0 ? (
        <div className="muted">{t('queue.empty')}</div>
      ) : (
        <table style={{ width: '100%', marginTop: 8 }}>
          <thead>
            <tr>
              <th align="left">{t('queue.colJob')}</th>
              <th align="left">{t('queue.colStatus')}</th>
              <th align="left">{t('queue.colProgress')}</th>
              <th align="left">{t('queue.colDiag')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <button className="link" onClick={() => void openJob(j.id)}>
                    {j.label}
                  </button>
                  <span className="muted"> {j.id}</span>
                </td>
                <td>
                  <StatusPill status={j.status} />
                  {j.cancelRequested && <span className="muted"> {t('queue.cancelling')}</span>}
                </td>
                <td>
                  {j.currentTask ? `${j.currentTask} ` : ''}
                  {j.completedTaskCount}/{j.taskCount}
                </td>
                <td>{j.diagnosticsAdded}</td>
                <td>
                  {(j.status === 'queued' || j.status === 'running') && (
                    <button onClick={() => void cancel(j.id)}>{t('queue.cancel')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && detail && (
        <div style={{ marginTop: 12 }}>
          <h4>
            {detail.job.label} <StatusPill status={detail.job.status} />
          </h4>
          {detail.tasks.map((task) => (
            <div key={task.label} className="muted">
              {task.label}: {t(`queue.taskStatus.${task.status}`)}
              {task.error ? ` — ${task.error}` : ''}
            </div>
          ))}
          {detail.diagnostics.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {detail.diagnostics.map((diag, i) => (
                <div key={i} className="muted">
                  {diag.file}:{diag.line}:{diag.column} [{diag.severity}] {diag.message}
                </div>
              ))}
            </div>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 }}>
            {logTruncated ? `${t('queue.logTruncated')}\n` : ''}
            {log || t('queue.noLog')}
          </pre>
        </div>
      )}
      {active && <div className="muted">{t('queue.pollingNote')}</div>}
      <div className="muted" style={{ marginTop: 8 }}>
        {t('queue.honest')}
      </div>
    </div>
  );
}
