import { useCallback, useEffect, useState } from 'react';
import {
  api,
  authHeaders,
  defaultApiBase,
  type QueueJobView,
  type TaskRunsResponse,
  type TimelineDetailResponse,
  type TimelineStepView,
} from '../api';
import { useLang } from '../i18n';

const API_BASE = defaultApiBase();

type RunView = TaskRunsResponse['runs'][number];

/**
 * V3-#7 Cascade-style task timeline — one card per chain step.
 *
 * Shows recent tasks.json chain runs as step cards (label, command,
 * status, exit code, duration, diagnostics, collapsible output, record
 * digest). Rollback marks later steps 'superseded' — it never deletes or
 * rewrites history, and it never reverts files: file revert stays with
 * the existing shadow-checkpoint restore, linked per run below. Rerun
 * starts a new chain run from a step through the same execution channel
 * as a manual run. Queue-conflict rule: rollback only marks this
 * timeline; it does not stop a same-label job already running in the
 * task queue, so an active-job warning is shown instead of pretending
 * otherwise.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - List-view step outputs are stripped (detail view carries full output).
 *  - outputDigest is the SHA-256 of the stored (capped) output record,
 *    not a build-artifact digest.
 *  - Full timelines are process-local: a server restart clears step
 *    cards and outputs. Run METADATA persists across restarts (V3.0
 *    audit round 2, item #10) and is marked persisted below; a persisted
 *    run is a view of a past run, not a re-execution channel — it cannot
 *    be rolled back or re-run from its record.
 *  - A step whose command the planner did not know is shown with an
 *    explicit unknown marker and coverage 'partial', never invented.
 */

function StatusPill({ status }: { status: TimelineStepView['status'] }) {
  const { t } = useLang();
  const cls =
    status === 'ok'
      ? 'pill'
      : status === 'skipped' || status === 'superseded'
        ? 'pill muted'
        : 'pill warn';
  return <span className={cls}>{t(`timeline.status.${status}`)}</span>;
}

function StepCard({
  step,
  onRollback,
  onRerun,
  busy,
}: {
  step: TimelineStepView;
  onRollback: (label: string) => void;
  onRerun: (label: string) => void;
  busy: boolean;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const canRollback = step.status !== 'superseded';
  return (
    <div className="tasks-result">
      <div
        className="tasks-result-head"
        onClick={() => setOpen((s) => !s)}
        role="button"
        tabIndex={0}
      >
        <StatusPill status={step.status} />
        <b>
          #{step.index + 1} {step.label}
        </b>
        <span className="muted">
          {step.command ?? t('timeline.commandUnknown')}
          {' · '}
          {t('tasks.exitCode', { code: step.exitCode === null ? '—' : String(step.exitCode) })}
          {' · '}
          {t('tasks.duration', { ms: String(step.durationMs) })}
          {step.diagnosticsAdded > 0 && (
            <>
              {' · '}
              {t('tasks.diagnostics', { count: String(step.diagnosticsAdded) })}
            </>
          )}
        </span>
      </div>
      {step.error && <div className="pill warn">{step.error}</div>}
      {step.notes?.map((n) => (
        <div key={n} className="muted">
          {n}
        </div>
      ))}
      {step.supersededAt && (
        <div className="muted">{t('timeline.supersededAt', { at: step.supersededAt })}</div>
      )}
      <div className="tasks-toolbar">
        <button className="link" disabled={busy || !canRollback} onClick={() => onRollback(step.label)}>
          {t('timeline.rollbackTo')}
        </button>
        <button className="link" disabled={busy} onClick={() => onRerun(step.label)}>
          {t('timeline.rerunFrom')}
        </button>
        <span className="muted" title={step.outputDigest}>
          {t('timeline.digest', { digest: step.outputDigest.slice(0, 12) })}
          {step.outputTruncated ? ` (${t('timeline.truncated')})` : ''}
        </span>
      </div>
      {open && <pre className="tasks-output">{step.output || t('tasks.noOutput')}</pre>}
    </div>
  );
}

export function CascadeTimelinePanel() {
  const { t } = useLang();
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TimelineDetailResponse | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [queueJobs, setQueueJobs] = useState<QueueJobView[] | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.tasksRuns();
      setRuns(r.runs);
      try {
        const q = await api.queueJobs();
        setQueueJobs(q.jobs);
      } catch {
        setQueueJobs(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback(
    async (id: string) => {
      if (openId === id) {
        setOpenId(null);
        setDetail(null);
        return;
      }
      setOpenId(id);
      setDetailErr(null);
      try {
        setDetail(await api.timelineDetail(id));
      } catch (e) {
        setDetailErr(e instanceof Error ? e.message : String(e));
      }
    },
    [openId],
  );

  const rollback = useCallback(
    async (runId: string, label: string) => {
      if (!window.confirm(t('timeline.rollbackConfirm', { label }))) return;
      setBusy(true);
      setMsg(null);
      try {
        const r = await api.timelineRollback(runId, label);
        setMsg(t('timeline.rollbackDone', { count: String(r.superseded.length) }));
        setDetail((d) => (d && d.run.id === runId ? { ...d, run: r.run } : d));
        await load();
      } catch (e) {
        setMsg(t('timeline.actionFailed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const rerun = useCallback(
    async (runId: string, label: string) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await api.timelineRerun(runId, label);
        setMsg(
          t('timeline.rerunDone', {
            id: r.run?.id ?? '—',
            ok: r.chain.ok ? t('tasks.chainOk') : t('tasks.chainFailed'),
          }),
        );
        await load();
      } catch (e) {
        setMsg(t('timeline.actionFailed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  // V3.0 audit round 2, item #10: clear persisted run metadata only;
  // live in-memory timelines are untouched. Confirmed, audited server-side.
  const clearPersisted = useCallback(async () => {
    if (!window.confirm(t('runhist.clearConfirm'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.tasksClearRunHistory();
      setMsg(t('runhist.cleared', { count: r.cleared === null ? '?' : String(r.cleared) }));
      await load();
    } catch (e) {
      setMsg(t('timeline.actionFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const restoreCheckpoint = useCallback(
    async (cp: { id: string; workspaceId: string; workspacePath: string }) => {
      if (!window.confirm(t('timeline.restoreConfirm', { id: cp.id }))) return;
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch(`${API_BASE}/shadow-checkpoints/${cp.id}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            workspaceId: cp.workspaceId,
            workspacePath: cp.workspacePath,
          }),
        });
        const body = (await res.json()) as { error?: string; restoredId?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setMsg(t('timeline.restoreDone', { id: body.restoredId ?? cp.id }));
      } catch (e) {
        setMsg(t('timeline.actionFailed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  if (err) {
    return (
      <div>
        <span className="pill warn">{t('timeline.loadFailed', { message: err })}</span>{' '}
        <button className="link" onClick={load}>
          {t('tasks.retry')}
        </button>
      </div>
    );
  }
  if (runs === null) return <div className="muted">{t('tasks.loading')}</div>;

  return (
    <div className="timeline-panel">
      <div className="tasks-toolbar">
        <b>{t('timeline.title')}</b>
        <button className="link" onClick={load}>
          {t('tasks.refresh')}
        </button>
        <button className="link" disabled={busy} onClick={clearPersisted}>
          {t('runhist.clear')}
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {runs.length === 0 && <div className="muted">{t('timeline.runsEmpty')}</div>}
      {runs.map((run) => {
        const activeQueue = (queueJobs ?? []).filter(
          (j) => (j.status === 'queued' || j.status === 'running') && j.chain.includes(run.label),
        );
        const shown = openId === run.id && detail ? detail.run : run;
        return (
          <div key={run.id} className="tasks-results">
            <div className="tasks-results-head">
              <b>{run.label}</b>
              <span className="muted">
                {run.ok ? t('tasks.chainOk') : t('tasks.chainFailed')}
                {run.persisted && ` · ${t('runhist.persisted')}`}
                {run.stoppedAt && ` · ${t('tasks.stoppedAt', { label: run.stoppedAt })}`}
                {run.rerunOf && ` · ${t('timeline.rerunOf', { id: run.rerunOf, from: run.rerunFrom ?? '—' })}`}
                {run.supersededFrom && ` · ${t('timeline.rolledBackTo', { label: run.supersededFrom })}`}
              </span>
              <button className="link" onClick={() => openDetail(run.id)}>
                {openId === run.id ? t('timeline.collapse') : t('timeline.expand')}
              </button>
            </div>
            {activeQueue.length > 0 && (
              <div className="pill warn">
                {t('timeline.queueConflict', { count: String(activeQueue.length) })}
              </div>
            )}
            {run.coverage === 'partial' && (
              <div className="muted">{run.coverageNote ?? t('timeline.partial')}</div>
            )}
            {openId === run.id && (
              <>
                {detailErr && <div className="pill warn">{detailErr}</div>}
                {detail?.persistedNote && <div className="muted">{t('runhist.persistedNote')}</div>}
                {shown.steps.map((step) => (
                  <StepCard
                    key={step.label}
                    step={step}
                    onRollback={(label) => rollback(run.id, label)}
                    onRerun={(label) => rerun(run.id, label)}
                    busy={busy}
                  />
                ))}
                {detail && (
                  <div className="tasks-results">
                    <b>{t('timeline.checkpoints')}</b>
                    {detail.checkpointError && (
                      <div className="pill warn">
                        {t('timeline.checkpointError', { message: detail.checkpointError })}
                      </div>
                    )}
                    {detail.checkpoints.length === 0 && !detail.checkpointError && (
                      <div className="muted">{t('timeline.noCheckpoints')}</div>
                    )}
                    {detail.checkpoints.map((cp) => (
                      <div key={cp.id} className="tasks-row">
                        <span className="muted">
                          {cp.id} · {cp.createdAt} · {cp.label}
                        </span>{' '}
                        <button
                          className="pill"
                          disabled={busy}
                          onClick={() => restoreCheckpoint(cp)}
                        >
                          {t('timeline.restore')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      <div className="muted tasks-hint">{t('timeline.honest')}</div>
    </div>
  );
}
