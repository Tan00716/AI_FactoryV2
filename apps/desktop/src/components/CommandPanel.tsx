import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuditRecord,
  type BudgetUsageView,
  type QueueJobsResponse,
  type TaskRunsResponse,
} from '../api';
import { useLang } from '../i18n';
import {
  CLOUD_GATE,
  summarizeBudgets,
  summarizeQueue,
  summarizeRuns,
  type CommandBudgetRow,
  type CommandQueueJobRow,
  type CommandRunRow,
} from './commandOverview';

/**
 * V3.0 audit round 3, item #5: task command overview — a READ-ONLY
 * aggregation view nested at the top of the Tasks panel. It adds no
 * centre tab and no bottom tab (with #9 it forms a single visibility
 * layer), and it never triggers execution: every fetch below is a GET.
 *
 * Field -> source mapping (each section footer names its source):
 * - Latest runs: GET /api/tasks/runs (live ring + persisted metadata;
 *   persisted rows carry metadata only, no step data, and are badged).
 * - Background queue: GET /api/taskqueue/jobs + /config, grouped into
 *   in-progress (running jobs with current task + progress), queued, and
 *   finished. In-progress covers queue running jobs only: a foreground
 *   chain has no global GET row while running (the runs ring records a
 *   run only after it finishes), so it is never listed here.
 * - Refresh: manual refresh + 30s auto-refresh; the toolbar shows when
 *   the displayed data was fetched.
 * - Budgets: GET /api/quota/budgets. Usage is simulated / reported
 *   estimates (V3-#8), never vendor-measured consumption: every row
 *   carries an estimate badge and the API basis string is shown verbatim.
 * - Cloud: NO source. Audit #1 (a real Codex turn) has not been
 *   verified, so this section is an explicit empty state. No placeholder
 *   rows are ever rendered here, and local rows are never passed off
 *   as cloud rows.
 * - Audit chain: GET /api/audit (latest 5 records); the full immutable
 *   chain lives in the bottom AI Activity tab, named in text (the
 *   desktop renderer cannot jump bottom tabs, so no link is faked).
 */

function LocalBadge() {
  const { t } = useLang();
  return <span className="pill">{t('command.local')}</span>;
}

export function CommandPanel() {
  const { t } = useLang();
  const [runs, setRuns] = useState<CommandRunRow[]>([]);
  const [runCounts, setRunCounts] = useState({ ok: 0, fail: 0 });
  const [queue, setQueue] = useState<{ running: number; queued: number; maxConcurrency: number; jobs: CommandQueueJobRow[] } | null>(null);
  const [budgets, setBudgets] = useState<CommandBudgetRow[]>([]);
  const [budgetCounts, setBudgetCounts] = useState({ tripped: 0, warned: 0 });
  const [basis, setBasis] = useState('');
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const next: Record<string, string> = {};
    const [rRuns, rQueue, rBudgets, rAudit] = await Promise.allSettled([
      api.tasksRuns(),
      api.queueJobs(),
      api.budgets(),
      api.audit(5),
    ]);
    if (rRuns.status === 'fulfilled') {
      const s = summarizeRuns((rRuns.value as TaskRunsResponse).runs ?? []);
      setRuns(s.rows);
      setRunCounts({ ok: s.okCount, fail: s.failCount });
    } else {
      next['runs'] = (rRuns.reason as Error).message ?? String(rRuns.reason);
    }
    if (rQueue.status === 'fulfilled') {
      const v = rQueue.value as QueueJobsResponse;
      setQueue(summarizeQueue({ running: v.running, queued: v.queued, maxConcurrency: v.config.maxConcurrency, jobs: v.jobs }));
    } else {
      next['queue'] = (rQueue.reason as Error).message ?? String(rQueue.reason);
    }
    if (rBudgets.status === 'fulfilled') {
      const v = rBudgets.value as { budgets: BudgetUsageView[]; basis: string };
      const s = summarizeBudgets(v.budgets ?? []);
      setBudgets(s.rows);
      setBudgetCounts({ tripped: s.tripped, warned: s.warned });
      setBasis(v.basis ?? '');
    } else {
      next['budgets'] = (rBudgets.reason as Error).message ?? String(rBudgets.reason);
    }
    if (rAudit.status === 'fulfilled') {
      setAudit((rAudit.value as AuditRecord[]).slice(0, 5));
    } else {
      next['audit'] = (rAudit.reason as Error).message ?? String(rAudit.reason);
    }
    setErrs(next);
    setLoading(false);
    setRefreshedAt(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh policy (V3R5-#7): auto-refresh every 30s + manual refresh.
  // Aggregation latency is bounded by the slowest single GET in load();
  // a failed section keeps its previous rows with a failure pill, and the
  // timestamp above shows when those rows were fetched, so stale data is
  // never presented as real-time.
  useEffect(() => {
    const timer = setInterval(() => { void load(true); }, 30000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="command-panel">
      <div className="tasks-toolbar">
        <b>{t('command.title')}</b>
        <span className="muted">{t('command.subtitle')}</span>
        <button className="link" onClick={() => { void load(); }}>{t('command.refresh')}</button>
        {refreshedAt && <span className="muted">{t('command.refreshedAt', { time: refreshedAt })}</span>}
      </div>
      {loading && <div className="muted">{t('command.loading')}</div>}

      <h3>{t('command.runs')}</h3>
      {errs['runs'] ? (
        <div><span className="pill warn">{t('command.loadFailed', { message: errs['runs'] })}</span>{' '}<button className="link" onClick={() => { void load(); }}>{t('command.retry')}</button></div>
      ) : runs.length === 0 ? (
        <div className="muted">{t('command.noRuns')}</div>
      ) : (
        <div>
          <div className="muted">{t('command.runCounts', { ok: String(runCounts.ok), fail: String(runCounts.fail) })}</div>
          {runs.map((r) => (
            <div key={r.id} className="tasks-result">
              <LocalBadge />{' '}
              <b>{r.label}</b>{' '}
              <span className={r.ok ? 'pill' : 'pill warn'}>{r.ok ? t('command.runOk') : t('command.runFailed')}</span>{' '}
              {r.persisted && <span className="pill muted">{t('command.persisted')}</span>}{' '}
              <span className="muted">{t('command.runMeta', { tasks: String(r.taskCount), finished: r.finishedAt })}</span>
            </div>
          ))}
        </div>
      )}
      <div className="muted tasks-hint">{t('command.sourceRuns')}</div>

      <h3>{t('command.queue')}</h3>
      {errs['queue'] ? (
        <div><span className="pill warn">{t('command.loadFailed', { message: errs['queue'] })}</span>{' '}<button className="link" onClick={() => { void load(); }}>{t('command.retry')}</button></div>
      ) : !queue ? (
        <div className="muted">{t('command.noJobs')}</div>
      ) : (
        <div>
          <div className="muted">{t('command.queueCounts', { running: String(queue.running), queued: String(queue.queued), cap: String(queue.maxConcurrency) })}</div>
          <h4>{t('command.inProgress')}</h4>
          {queue.jobs.filter((j) => j.status === 'running').length === 0 ? (
            <div className="muted">{t('command.noRunning')}</div>
          ) : (
            queue.jobs.filter((j) => j.status === 'running').map((j) => (
              <div key={j.id} className="tasks-result" data-command-running-job={j.id}>
                <LocalBadge />{' '}
                <b>{j.label}</b>{' '}
                <span className="pill muted">{t(`queue.status.${j.status}`)}</span>{' '}
                <span className="muted">{t('command.jobProgress', { done: String(j.completedTaskCount), total: String(j.taskCount) })}</span>{' '}
                <span className="muted">{j.currentTask ? t('command.currentTask', { task: j.currentTask }) : t('command.currentTaskNone')}</span>
              </div>
            ))
          )}
          <div className="muted tasks-hint">{t('command.inProgressNote')}</div>
          <h4>{t('command.queuedJobs')}</h4>
          {queue.jobs.filter((j) => j.status === 'queued').length === 0 ? (
            <div className="muted">{t('command.noQueued')}</div>
          ) : (
            queue.jobs.filter((j) => j.status === 'queued').map((j) => (
              <div key={j.id} className="tasks-result">
                <LocalBadge />{' '}
                <b>{j.label}</b>{' '}
                <span className="pill muted">{t(`queue.status.${j.status}`)}</span>
              </div>
            ))
          )}
          <h4>{t('command.finishedJobs')}</h4>
          {queue.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued').length === 0 ? (
            <div className="muted">{t('command.noJobs')}</div>
          ) : (
            queue.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued').map((j) => (
              <div key={j.id} className="tasks-result">
                <LocalBadge />{' '}
                <b>{j.label}</b>{' '}
                <span className="pill muted">{t(`queue.status.${j.status}`)}</span>
              </div>
            ))
          )}
        </div>
      )}
      <div className="muted tasks-hint">{t('command.sourceQueue')}</div>

      <h3>{t('command.budgets')}</h3>
      {errs['budgets'] ? (
        <div><span className="pill warn">{t('command.loadFailed', { message: errs['budgets'] })}</span>{' '}<button className="link" onClick={() => { void load(); }}>{t('command.retry')}</button></div>
      ) : budgets.length === 0 ? (
        <div className="muted">{t('command.noBudgets')}</div>
      ) : (
        <div>
          <div className="muted">{t('command.budgetCounts', { tripped: String(budgetCounts.tripped), warned: String(budgetCounts.warned) })}</div>
          {budgets.map((b) => (
            <div key={b.id} className="tasks-result">
              <LocalBadge />{' '}
              <b>{b.scopeKey}</b>{' '}
              <span className="muted">{t('command.budgetUsage', { used: String(b.used), limit: String(b.limit), pct: String(b.pct), unit: b.unit })}</span>{' '}
              <span className={b.status === 'tripped' ? 'pill warn' : 'pill muted'}>{t(`command.budgetStatus.${b.status}`)}</span>{' '}
              <span className="pill warn">{t('command.estimated')}</span>
            </div>
          ))}
          {basis && <div className="muted">{t('command.basis', { basis })}</div>}
        </div>
      )}
      <div className="muted tasks-hint">{t('command.sourceBudgets')}</div>

      <h3>{t('command.cloud')}</h3>
      <div className="muted" data-command-cloud-empty="true">
        {t('command.cloudEmpty')}
      </div>
      <div className="muted tasks-hint">{t('command.sourceCloud')}</div>

      <h3>{t('command.audit')}</h3>
      {errs['audit'] ? (
        <div><span className="pill warn">{t('command.loadFailed', { message: errs['audit'] })}</span>{' '}<button className="link" onClick={() => { void load(); }}>{t('command.retry')}</button></div>
      ) : audit.length === 0 ? (
        <div className="muted">{t('command.noAudit')}</div>
      ) : (
        audit.map((a) => (
          <div key={a.id} className="tasks-result">
            <LocalBadge />{' '}
            <b>{a.action}</b>{' '}
            <span className="muted">{a.entityType}/{a.entityId} · {a.ts}</span>
          </div>
        ))
      )}
      <div className="muted tasks-hint">{t('command.sourceAudit')}</div>
      <div className="muted tasks-hint">{t('command.cloudGateNote', { connected: CLOUD_GATE.connected ? t('command.yes') : t('command.no') })}</div>
    </div>
  );
}
