import { useCallback, useEffect, useState } from 'react';
import { api, type ScheduleItem, type ScheduleRunRecord } from '../api';
import { useLang } from '../i18n';

/**
 * Task schedules panel (round-6 task R6-S5) — operator-configured
 * schedules on top of the pre-existing server scheduler (cron + interval
 * + one-time kinds; run-task / webhook / backup / task-runner jobs).
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 *  - Schedules only fire while the server is running — there is no
 *    system-level daemon. A slot missed while the server was down is
 *    recorded as missed, never backfilled.
 *  - Cron expressions are evaluated in UTC (pre-existing scheduler
 *    semantics); the server's local timezone is shown for reference.
 *  - A slot that fires while the previous run is still in progress is
 *    recorded as skipped, never queued — runs never pile up.
 *  - task-runner jobs run a declarative tasks.json chain through the
 *    SAME exec safety policy as a manual task run (no new channel).
 */

type JobType = 'task-runner' | 'run-task' | 'webhook' | 'backup';

function jobSummary(job: Record<string, unknown>): string {
  const t = job['type'];
  if (t === 'task-runner') return `task-runner: ${String(job['label'] ?? '')}`;
  if (t === 'run-task') return `run-task: ${String(job['title'] ?? '')}`;
  if (t === 'webhook') return `webhook: ${String(job['url'] ?? '')}`;
  if (t === 'backup') return 'backup';
  return String(t ?? '');
}

function kindSummary(s: ScheduleItem): string {
  if (s.kind === 'cron') return `cron ${s.cronExpr ?? ''}`;
  if (s.kind === 'interval') return `every ${Math.round((s.intervalMs ?? 0) / 1000)}s`;
  return `once ${s.runAt ? new Date(s.runAt).toLocaleString() : ''}`;
}

export function SchedulesPanel() {
  const { t } = useLang();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [cronTz, setCronTz] = useState('UTC');
  const [serverTz, setServerTz] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'cron' | 'interval' | 'once'>('interval');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [intervalSec, setIntervalSec] = useState(3600);
  const [runAt, setRunAt] = useState('');
  const [jobType, setJobType] = useState<JobType>('task-runner');
  const [taskLabel, setTaskLabel] = useState('');
  const [taskRoot, setTaskRoot] = useState('');
  const [runTitle, setRunTitle] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.schedulesList();
      setSchedules(res.schedules);
      setCronTz(res.cronTimezone);
      setServerTz(res.serverTimezone);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(async (id: string) => {
    setSelectedId(id);
    try {
      const res = await api.scheduleRuns(id);
      setRuns(res.runs);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const create = useCallback(async () => {
    setErr(null);
    let job: Record<string, unknown>;
    if (jobType === 'task-runner') {
      if (!taskLabel.trim()) {
        setErr(t('schedule.labelRequired'));
        return;
      }
      job = { type: 'task-runner', label: taskLabel.trim(), ...(taskRoot.trim() ? { root: taskRoot.trim() } : {}) };
    } else if (jobType === 'run-task') {
      if (!runTitle.trim()) {
        setErr(t('schedule.titleRequired'));
        return;
      }
      job = { type: 'run-task', title: runTitle.trim() };
    } else if (jobType === 'webhook') {
      if (!webhookUrl.trim()) {
        setErr(t('schedule.urlRequired'));
        return;
      }
      job = { type: 'webhook', url: webhookUrl.trim() };
    } else {
      job = { type: 'backup' };
    }
    try {
      await api.scheduleCreate({
        name: name.trim(),
        kind,
        ...(kind === 'cron' ? { cronExpr: cronExpr.trim() } : {}),
        ...(kind === 'interval' ? { intervalMs: Math.max(60, intervalSec) * 1000 } : {}),
        ...(kind === 'once' ? { runAt: runAt ? new Date(runAt).toISOString() : '' } : {}),
        job,
      });
      setName('');
      setTaskLabel('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [name, kind, cronExpr, intervalSec, runAt, jobType, taskLabel, taskRoot, runTitle, webhookUrl, load, t]);

  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setErr(null);
      try {
        await fn();
        await load();
        if (selectedId === id) await loadRuns(id);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [load, loadRuns, selectedId],
  );

  return (
    <div className="sched-panel">
      <h3>{t('schedule.title')}</h3>
      <p className="sched-tz-note">
        {t('schedule.tzNote', { cronTz, serverTz })}
      </p>
      {err && <div className="sched-error">{err}</div>}
      <div className="sched-create">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('schedule.namePlaceholder')} />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="cron">{t('schedule.kindCron')}</option>
          <option value="interval">{t('schedule.kindInterval')}</option>
          <option value="once">{t('schedule.kindOnce')}</option>
        </select>
        {kind === 'cron' && (
          <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 * * * *" />
        )}
        {kind === 'interval' && (
          <label>
            {t('schedule.intervalSec')}
            <input
              type="number"
              min={60}
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            />
          </label>
        )}
        {kind === 'once' && (
          <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
        )}
        <select value={jobType} onChange={(e) => setJobType(e.target.value as JobType)}>
          <option value="task-runner">{t('schedule.jobTaskRunner')}</option>
          <option value="run-task">{t('schedule.jobRunTask')}</option>
          <option value="webhook">{t('schedule.jobWebhook')}</option>
          <option value="backup">{t('schedule.jobBackup')}</option>
        </select>
        {jobType === 'task-runner' && (
          <>
            <input value={taskLabel} onChange={(e) => setTaskLabel(e.target.value)} placeholder={t('schedule.taskLabelPlaceholder')} />
            <input value={taskRoot} onChange={(e) => setTaskRoot(e.target.value)} placeholder={t('schedule.taskRootPlaceholder')} />
          </>
        )}
        {jobType === 'run-task' && (
          <input value={runTitle} onChange={(e) => setRunTitle(e.target.value)} placeholder={t('schedule.runTitlePlaceholder')} />
        )}
        {jobType === 'webhook' && (
          <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder={t('schedule.webhookUrlPlaceholder')} />
        )}
        <button onClick={() => void create()}>{t('schedule.create')}</button>
      </div>
      {loading && <div>{t('schedule.loading')}</div>}
      {schedules.length === 0 && !loading && <div>{t('schedule.empty')}</div>}
      <ul className="sched-list">
        {schedules.map((s) => (
          <li key={s.id} className="sched-item">
            <div className="sched-head">
              <strong>{s.name}</strong>
              <span>{kindSummary(s)}</span>
              <span>{jobSummary(s.job)}</span>
              <span>{s.status === 'active' ? t('schedule.active') : t('schedule.paused')}</span>
            </div>
            <div className="sched-meta">
              {t('schedule.nextRun')}: {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}
              {' · '}
              {t('schedule.lastStatus')}: {s.lastStatus ?? '—'}
              {' · '}
              {t('schedule.runCount')}: {s.runCount}
              {s.lastError ? ` · ${s.lastError}` : ''}
            </div>
            <div className="sched-actions">
              <button onClick={() => void act(s.id, () => api.scheduleUpdate(s.id, { status: s.status === 'active' ? 'paused' : 'active' }))}>
                {s.status === 'active' ? t('schedule.pause') : t('schedule.resume')}
              </button>
              <button onClick={() => void act(s.id, () => api.scheduleTrigger(s.id))}>{t('schedule.triggerNow')}</button>
              <button onClick={() => void loadRuns(s.id)}>{t('schedule.showRuns')}</button>
              <button onClick={() => void act(s.id, () => api.scheduleDelete(s.id))}>{t('schedule.delete')}</button>
            </div>
            {selectedId === s.id && (
              <ul className="sched-runs">
                {runs.length === 0 && <li>{t('schedule.noRuns')}</li>}
                {runs.map((r, i) => (
                  <li key={i}>
                    {new Date(r.firedAt).toLocaleString()} [{r.trigger}] {r.skipped ? t('schedule.skipped') : r.ok ? t('schedule.ok') : t('schedule.failed')}: {r.summary}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="sched-footer">{t('schedule.footer')}</p>
    </div>
  );
}
