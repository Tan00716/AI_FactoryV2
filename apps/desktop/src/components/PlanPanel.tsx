import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders, api, type TaskSummary } from '../api';
import { useLang } from '../i18n';

export interface PlanStep {
  title: string;
  detail?: string;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  steps: PlanStep[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'CANCELLED';
  approvalId: string;
  contentDigest: string;
  taskId: string | null;
  agentId: string | null;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string;
}

export interface PlanApi {
  list(status?: string): Promise<{ plans: Plan[] }>;
  create(input: {
    taskId: string;
    title: string;
    goal: string;
    steps: PlanStep[];
  }): Promise<{ plan: Plan; approval: unknown }>;
  approve(id: string, reason?: string): Promise<{ plan: Plan }>;
  reject(id: string, reason: string): Promise<{ plan: Plan }>;
  execute(id: string): Promise<{ plan: Plan }>;
}

const DEFAULT_BASE = defaultApiBase();

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createPlanApi(base: string = DEFAULT_BASE): PlanApi {
  return {
    list: (status) => req(base, `/plans${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    create: (input) => req(base, '/plans', { method: 'POST', body: JSON.stringify(input) }),
    approve: (id, reason) =>
      req(base, `/plans/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'human', reason: reason ?? '' }),
      }),
    reject: (id, reason) =>
      req(base, `/plans/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ decidedBy: 'human', reason }),
      }),
    execute: (id) =>
      req(base, `/plans/${encodeURIComponent(id)}/execute`, { method: 'POST', body: '{}' }),
  };
}

const STATUS_COLORS: Record<Plan['status'], string> = {
  PENDING: '#d29922',
  APPROVED: '#3fb950',
  REJECTED: '#f85149',
  EXECUTING: '#58a6ff',
  DONE: '#3fb950',
  CANCELLED: '#8b949e',
};

export function PlanPanel({ planApi }: { planApi: PlanApi }) {
  const { t } = useLang();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // create form
  const [taskId, setTaskId] = useState('');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState<PlanStep[]>([{ title: '' }]);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setError('');
      const [p, ts] = await Promise.all([planApi.list(), api.tasks()]);
      setPlans(p.plans);
      setTasks(ts);
      if (!taskId && ts.length > 0) setTaskId(ts[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setStep = (i: number, patch: Partial<PlanStep>) => {
    setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  };

  const doCreate = async () => {
    if (!taskId) {
      setError(t('plan.needsTask'));
      return;
    }
    if (!title.trim()) {
      setError(t('plan.needsTitle'));
      return;
    }
    const clean = steps.map((s) => ({ title: s.title.trim(), detail: s.detail?.trim() || undefined }))
      .filter((s) => s.title);
    if (clean.length === 0) {
      setError(t('plan.needsSteps'));
      return;
    }
    setBusy(true);
    try {
      setError('');
      await planApi.create({ taskId, title: title.trim(), goal: goal.trim(), steps: clean });
      setTitle('');
      setGoal('');
      setSteps([{ title: '' }]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      setError('');
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>{t('plan.title')}</h2>
      <p className="muted">{t('plan.desc')}</p>
      {error && <div className="error">{error}</div>}

      <h3>{t('plan.create')}</h3>
      <div className="form-grid">
        <label>
          {t('plan.task')}
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={busy}>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title} ({task.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('plan.planTitle')}
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
        <label>
          {t('plan.goal')}
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} disabled={busy} rows={2} />
        </label>
        <div>
          <div>{t('plan.steps')}</div>
          {steps.map((s, i) => (
            <div key={i} className="row" style={{ marginBottom: 4 }}>
              <input
                placeholder={t('plan.stepTitle')}
                value={s.title}
                onChange={(e) => setStep(i, { title: e.target.value })}
                disabled={busy}
                style={{ flex: 2 }}
              />
              <input
                placeholder={t('plan.stepDetail')}
                value={s.detail ?? ''}
                onChange={(e) => setStep(i, { detail: e.target.value })}
                disabled={busy}
                style={{ flex: 3 }}
              />
              <button
                disabled={busy || steps.length <= 1}
                onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
              >
                {t('plan.removeStep')}
              </button>
            </div>
          ))}
          <button disabled={busy} onClick={() => setSteps((s) => [...s, { title: '' }])}>
            {t('plan.addStep')}
          </button>
        </div>
        <div>
          <button disabled={busy} onClick={doCreate}>
            {busy ? t('plan.creating') : t('plan.create')}
          </button>
        </div>
      </div>

      <h3>
        {t('plan.title')} ({plans?.length ?? 0})
        <button className="link-btn" onClick={() => void refresh()} disabled={busy}>
          {t('plan.refresh')}
        </button>
      </h3>
      {plans === null ? (
        <div className="muted">…</div>
      ) : plans.length === 0 ? (
        <div className="muted">{t('plan.empty')}</div>
      ) : (
        <div className="card-list">
          {plans.map((p) => (
            <div key={p.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{p.title}</strong>
                <span style={{ color: STATUS_COLORS[p.status] }}>{p.status}</span>
              </div>
              {p.goal && <div className="muted">{p.goal}</div>}
              <ol>
                {p.steps.map((s, i) => (
                  <li key={i}>
                    {s.title}
                    {s.detail && <span className="muted"> — {s.detail}</span>}
                  </li>
                ))}
              </ol>
              <div className="muted" style={{ fontSize: 11 }}>
                {t('plan.createdBy')}: {p.createdBy} · {new Date(p.createdAt).toLocaleString()}
                {p.decisionReason && ` · ${p.decisionReason}`}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                {p.status === 'PENDING' && (
                  <>
                    <button disabled={busy} onClick={() => doAction(p.id, () => planApi.approve(p.id))}>
                      {t('plan.approve')}
                    </button>
                    <input
                      placeholder={t('plan.rejectReason')}
                      value={rejectReason[p.id] ?? ''}
                      onChange={(e) => setRejectReason((m) => ({ ...m, [p.id]: e.target.value }))}
                      disabled={busy}
                    />
                    <button
                      disabled={busy}
                      onClick={() => {
                        const reason = (rejectReason[p.id] ?? '').trim();
                        if (!reason) {
                          setError(t('plan.rejectReasonRequired'));
                          return;
                        }
                        void doAction(p.id, () => planApi.reject(p.id, reason));
                      }}
                    >
                      {t('plan.reject')}
                    </button>
                  </>
                )}
                {p.status === 'APPROVED' && (
                  <button disabled={busy} onClick={() => doAction(p.id, () => planApi.execute(p.id))}>
                    {t('plan.execute')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
