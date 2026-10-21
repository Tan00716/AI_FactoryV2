import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AgentFull,
  type DispatchTask,
  type DispatchTicket,
  type Project,
  type TaskAuthorizationStatus,
} from '../api';
import { useLang, type TFunc } from '../i18n';

/**
 * Dispatch（Batch 18）— §17.2 Human Dispatch 桌面队列。
 *
 * 数据全部来自服务端：GET /api/tasks 返回全量任务对象（授权轴
 * authorizationStatus、creator、时间戳都在列表里），五个派发动作
 * 与 Batch 17 服务端同一套状态机。本面板不自维护状态判断——
 * 服务端 409（状态已被他人变更）原样提示并刷新列表，不假装成功。
 *
 * 诚实口径：
 *  - 等待时长按 updatedAt 计算：授权流转在服务端会刷新 updatedAt，
 *    它是「最近一次状态变更时间」的可得近似；服务端没有专门的
 *    「进入 WAITING 时刻」字段，不另编造。列头注明口径。
 *  - via=POLICY 时 policyRuleId 前端先拦（与服务端 400 同口径）：
 *    预授权派发必须记录触发政策与 Rule ID，且服务端审计 actor
 *    记 policy、不冒充人工点击。
 *  - revoke / expire 按规格无出边（REVOKED / EXPIRED 无恢复路径），
 *    执行前二次确认并把后果写清。
 *  - 预授权票区依赖服务端 Batch 18-1 的 GET /api/dispatch-tickets：
 *    端点未就绪（404）时如实显示「端点未就绪」，不编造任何票面。
 */

type Toast = { kind: 'ok' | 'err'; text: string };

type TicketsState =
  | { phase: 'loading' }
  | { phase: 'not-ready'; status: number }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; tickets: DispatchTicket[] };

interface DispatchForm {
  assigneeAgentId: string;
  via: 'HUMAN' | 'POLICY';
  policyRuleId: string;
  reason: string;
}

const EMPTY_FORM: DispatchForm = {
  assigneeAgentId: '',
  via: 'HUMAN',
  policyRuleId: '',
  reason: '',
};

function authOf(t: DispatchTask): TaskAuthorizationStatus {
  return t.authorizationStatus ?? 'AUTHORIZED';
}

function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** 等待时长（自 updatedAt 起算的近似，见文件头口径）。 */
function fmtWait(sinceIso: string, now: number, t: TFunc): string {
  const parsed = Date.parse(sinceIso);
  if (Number.isNaN(parsed)) return '—';
  const min = Math.floor(Math.max(0, now - parsed) / 60000);
  if (min < 1) return t('dispatch.waitUnder1Min');
  if (min < 60) return t('dispatch.waitMinutes', { min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('dispatch.waitHoursMins', { h, m: min % 60 });
  return t('dispatch.waitDaysHours', { d: Math.floor(h / 24), h: h % 24 });
}

function scopeText(scope: unknown): string {
  if (scope === undefined || scope === null) return '—';
  if (typeof scope === 'string') return scope;
  try {
    return JSON.stringify(scope);
  } catch {
    return String(scope);
  }
}

export function DispatchPanel() {
  const { t } = useLang();
  const [tasks, setTasks] = useState<DispatchTask[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentFull[]>([]);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, DispatchForm>>({});
  /** 二次确认中的危险动作（revoke / expire）。 */
  const [confirm, setConfirm] = useState<{ taskId: string; action: 'revoke' | 'expire' } | null>(null);
  const [tickets, setTickets] = useState<TicketsState>({ phase: 'loading' });
  const [now, setNow] = useState(() => Date.now());

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // 等待时长每 30 秒刷新一次显示（只重渲染，不重新拉数据）。
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setErr('');
    try {
      setTasks(await api.dispatchTasks());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // 项目名与 agent 名只是展示辅助：拉不到时回退显示 id 本身，
    // 不让辅助数据失败拖垮队列本身。
    api.projects().then(setProjects).catch(() => setProjects([]));
    api.agents().then(setAgents).catch(() => setAgents([]));
  }, [load]);

  // 预授权票（服务端 Batch 18-1）：404 = 端点未就绪，如实呈现。
  useEffect(() => {
    let cancelled = false;
    api
      .dispatchTickets()
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 404) {
          setTickets({ phase: 'not-ready', status });
          return;
        }
        if (status >= 400) {
          setTickets({ phase: 'error', message: `HTTP ${status}` });
          return;
        }
        const list = Array.isArray(body) ? body : (body.tickets ?? []);
        setTickets({ phase: 'ready', tickets: list });
      })
      .catch((e: Error) => {
        if (!cancelled) setTickets({ phase: 'error', message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? id,
    [projects],
  );

  const formFor = useCallback(
    (taskId: string): DispatchForm => forms[taskId] ?? EMPTY_FORM,
    [forms],
  );
  const setForm = useCallback((taskId: string, patch: Partial<DispatchForm>) => {
    setForms((s) => ({ ...s, [taskId]: { ...(s[taskId] ?? EMPTY_FORM), ...patch } }));
  }, []);

  /**
   * 统一动作执行：成功 → toast（带服务端回的 from → to）+ 刷新；
   * 失败 → 服务端错误原文 toast；409（状态已变）额外刷新列表，
   * 让操作员看到当前真实状态，而不是按旧状态继续操作。
   */
  const act = useCallback(
    async (
      task: DispatchTask,
      label: string,
      fn: () => Promise<{ from: string; to: string }>,
    ) => {
      setBusyId(task.id);
      try {
        const res = await fn();
        showToast(
          'ok',
          t('dispatch.toastSuccess', {
            label,
            title: task.title,
            from: res.from,
            to: res.to,
          }),
        );
        setConfirm(null);
        await load();
      } catch (e) {
        const errObj = e as Error & { status?: number };
        showToast(
          'err',
          t('dispatch.toastFailed', {
            label,
            title: task.title,
            status: errObj.status ?? '?',
            message: errObj.message,
          }),
        );
        if (errObj.status === 409) await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, showToast, t],
  );

  const doDispatch = useCallback(
    (task: DispatchTask) => {
      const f = formFor(task.id);
      if (f.via === 'POLICY' && !f.policyRuleId.trim()) {
        showToast('err', t('dispatch.policyRuleIdRequired'));
        return;
      }
      void act(task, t('dispatch.action.dispatch'), () =>
        api.dispatchTask(task.id, {
          via: f.via,
          ...(f.assigneeAgentId ? { assigneeAgentId: f.assigneeAgentId } : {}),
          ...(f.via === 'POLICY' ? { policyRuleId: f.policyRuleId.trim() } : {}),
        }),
      );
    },
    [act, formFor, showToast, t],
  );

  const doReject = useCallback(
    (task: DispatchTask) => {
      const reason = formFor(task.id).reason.trim();
      void act(task, t('dispatch.action.reject'), () =>
        api.rejectDispatch(task.id, reason || undefined),
      );
    },
    [act, formFor, t],
  );

  const groups = useMemo(() => {
    const all = tasks ?? [];
    const byCreated = (a: DispatchTask, b: DispatchTask) =>
      a.createdAt.localeCompare(b.createdAt);
    return {
      waiting: all
        .filter((t) => authOf(t) === 'WAITING_HUMAN_DISPATCH')
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
      drafts: all.filter((t) => authOf(t) === 'DRAFT').sort(byCreated),
      authorized: all.filter((t) => authOf(t) === 'AUTHORIZED').sort(byCreated),
      closed: all
        .filter((t) => authOf(t) === 'REVOKED' || authOf(t) === 'EXPIRED')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }, [tasks]);

  const taskCell = (task: DispatchTask) => (
    <>
      <td>
        <strong>{task.title}</strong>
        <div className="muted" style={{ fontSize: 11 }}>
          <code title={task.id}>{task.id.slice(0, 8)}…</code> · {t('dispatch.workflowStatus', { status: task.status })}
        </div>
      </td>
      <td>{projectName(task.projectId)}</td>
      <td>
        {task.creator}
        {task.creator === 'sweep' && (
          <span
            className="sweep-tag"
            title={t('sweep.originTitle')}
            style={{ marginLeft: 6 }}
          >
            {t('sweep.originBadge')}
          </span>
        )}
      </td>
      <td><span className={`prio ${task.priority.toLowerCase()}`}>{task.priority}</span></td>
    </>
  );

  return (
    <div className="panel">
      <h2>
        Dispatch <span className="muted">{t('dispatch.subtitle')}</span>
      </h2>
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
      {err && <div className="banner err">{t('dispatch.loadFailed', { message: err })}</div>}
      <div className="row">
        <button onClick={() => void load()}>{t('dispatch.refresh')}</button>
        {tasks !== null && (
          <span className="muted">
            {t('dispatch.counts', {
              waiting: groups.waiting.length,
              drafts: groups.drafts.length,
              authorized: groups.authorized.length,
              closed: groups.closed.length,
            })}
          </span>
        )}
      </div>

      {tasks === null && !err && <p className="muted">{t('dispatch.loadingTasks')}</p>}

      {/* ------------------------------------------------ 待派发队列 */}
      <h3>{t('dispatch.waiting')}</h3>
      {tasks !== null && groups.waiting.length === 0 && (
        <p className="muted">{t('dispatch.waitingEmpty')}</p>
      )}
      {groups.waiting.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('dispatch.col.task')}</th><th>{t('dispatch.col.project')}</th>
              <th>{t('dispatch.col.creator')}</th><th>{t('dispatch.col.priority')}</th>
              <th>{t('dispatch.col.wait')}</th><th>{t('dispatch.col.dispatch')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.waiting.map((task) => {
              const f = formFor(task.id);
              const busy = busyId === task.id;
              return [
                <tr key={task.id}>
                  {taskCell(task)}
                  <td>
                    {fmtWait(task.updatedAt, now, t)}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {t('dispatch.changedAt', { time: fmtTime(task.updatedAt) })}
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
                      <select
                        aria-label={t('dispatch.assignTo')}
                        value={f.assigneeAgentId}
                        disabled={busy}
                        onChange={(e) => setForm(task.id, { assigneeAgentId: e.target.value })}
                      >
                        <option value="">{t('dispatch.noAssignee')}</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName}（{a.jobTitle}）
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={t('dispatch.via')}
                        value={f.via}
                        disabled={busy}
                        onChange={(e) =>
                          setForm(task.id, { via: e.target.value as 'HUMAN' | 'POLICY' })
                        }
                      >
                        <option value="HUMAN">{t('dispatch.viaHuman')}</option>
                        <option value="POLICY">{t('dispatch.viaPolicy')}</option>
                      </select>
                      {f.via === 'POLICY' && (
                        <input
                          type="text"
                          aria-label="policyRuleId"
                          placeholder={t('dispatch.policyRuleIdPlaceholder')}
                          value={f.policyRuleId}
                          disabled={busy}
                          onChange={(e) => setForm(task.id, { policyRuleId: e.target.value })}
                        />
                      )}
                    </div>
                  </td>
                </tr>,
                <tr key={`${task.id}-actions`}>
                  <td colSpan={6}>
                    <div className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
                      <button disabled={busy} onClick={() => doDispatch(task)}>
                        {busy ? t('dispatch.processing') : t('dispatch.dispatchBtn')}
                      </button>
                      <input
                        type="text"
                        aria-label={t('dispatch.rejectReasonLabel')}
                        placeholder={t('dispatch.rejectReasonPlaceholder')}
                        value={f.reason}
                        disabled={busy}
                        onChange={(e) => setForm(task.id, { reason: e.target.value })}
                      />
                      <button disabled={busy} onClick={() => doReject(task)}>
                        {t('dispatch.rejectBtn')}
                      </button>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {t('dispatch.hintDispatched')}
                        {f.via === 'POLICY'
                          ? t('dispatch.hintPolicyActor')
                          : t('dispatch.hintHumanEvent')}
                      </span>
                    </div>
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      )}

      {/* ------------------------------------------------------ 草稿 */}
      <h3>{t('dispatch.drafts')}</h3>
      {tasks !== null && groups.drafts.length === 0 && (
        <p className="muted">{t('dispatch.draftsEmpty')}</p>
      )}
      {groups.drafts.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('dispatch.col.task')}</th><th>{t('dispatch.col.project')}</th>
              <th>{t('dispatch.col.creator')}</th><th>{t('dispatch.col.priority')}</th>
              <th>{t('dispatch.col.createdAt')}</th><th>{t('dispatch.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.drafts.map((task) => (
              <tr key={task.id}>
                {taskCell(task)}
                <td>{fmtTime(task.createdAt)}</td>
                <td>
                  <button
                    disabled={busyId === task.id}
                    onClick={() =>
                      void act(task, t('dispatch.action.requestDispatch'), () => api.requestDispatch(task.id))
                    }
                  >
                    {busyId === task.id ? t('dispatch.processing') : t('dispatch.requestDispatch')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ---------------------------------------------------- 已授权 */}
      <h3>{t('dispatch.authorized')}</h3>
      {tasks !== null && groups.authorized.length === 0 && (
        <p className="muted">{t('dispatch.authorizedEmpty')}</p>
      )}
      {groups.authorized.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('dispatch.col.task')}</th><th>{t('dispatch.col.project')}</th>
              <th>{t('dispatch.col.creator')}</th><th>{t('dispatch.col.priority')}</th>
              <th>{t('dispatch.col.currentAgent')}</th><th>{t('dispatch.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.authorized.map((task) => {
              const busy = busyId === task.id;
              const armed = confirm?.taskId === task.id ? confirm.action : null;
              return [
                <tr key={task.id}>
                  {taskCell(task)}
                  <td>
                    {task.currentAgentId ? (
                      <code title={task.currentAgentId}>{task.currentAgentId.slice(0, 8)}…</code>
                    ) : (
                      <span className="muted">{t('dispatch.unassigned')}</span>
                    )}
                  </td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() => setConfirm({ taskId: task.id, action: 'revoke' })}
                    >
                      {t('dispatch.revokeBtn')}
                    </button>{' '}
                    <button
                      disabled={busy}
                      onClick={() => setConfirm({ taskId: task.id, action: 'expire' })}
                    >
                      {t('dispatch.expireBtn')}
                    </button>
                  </td>
                </tr>,
                armed && (
                  <tr key={`${task.id}-confirm`}>
                    <td colSpan={6}>
                      <div className="banner err">
                        {armed === 'revoke'
                          ? t('dispatch.confirmRevoke', { title: task.title })
                          : t('dispatch.confirmExpire', { title: task.title })}
                      </div>
                      <div className="row">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              task,
                              armed === 'revoke' ? t('dispatch.action.revoke') : t('dispatch.action.expire'),
                              () =>
                                armed === 'revoke'
                                  ? api.revokeAuthorization(task.id)
                                  : api.expireAuthorization(task.id),
                            )
                          }
                        >
                          {busy
                            ? t('dispatch.processing')
                            : armed === 'revoke'
                              ? t('dispatch.confirmRevokeBtn')
                              : t('dispatch.confirmExpireBtn')}
                        </button>
                        <button disabled={busy} onClick={() => setConfirm(null)}>
                          {t('dispatch.cancel')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}

      {/* ---------------------------------------------- 已撤销/过期 */}
      <h3>{t('dispatch.closed')}</h3>
      {tasks !== null && groups.closed.length === 0 && (
        <p className="muted">{t('dispatch.closedEmpty')}</p>
      )}
      {groups.closed.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('dispatch.col.task')}</th><th>{t('dispatch.col.project')}</th>
                <th>{t('dispatch.col.creator')}</th><th>{t('dispatch.col.priority')}</th>
                <th>{t('dispatch.col.authStatus')}</th><th>{t('dispatch.col.changedTime')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.closed.map((task) => (
                <tr key={task.id}>
                  {taskCell(task)}
                  <td><span className="pill warn">{authOf(task)}</span></td>
                  <td>{fmtTime(task.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {t('dispatch.closedNote')}
          </p>
        </>
      )}

      {/* -------------------------------------------------- 预授权票 */}
      <h3>{t('dispatch.tickets')}</h3>
      {tickets.phase === 'loading' && <p className="muted">{t('dispatch.loadingTickets')}</p>}
      {tickets.phase === 'not-ready' && (
        <p className="muted">
          {t('dispatch.ticketsNotReady', { status: tickets.status })}
        </p>
      )}
      {tickets.phase === 'error' && (
        <div className="banner err">{t('dispatch.ticketsFailed', { message: tickets.message })}</div>
      )}
      {tickets.phase === 'ready' && tickets.tickets.length === 0 && (
        <p className="muted">{t('dispatch.ticketsEmpty')}</p>
      )}
      {tickets.phase === 'ready' && tickets.tickets.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('dispatch.col.ticket')}</th><th>{t('dispatch.col.ruleId')}</th>
              <th>{t('dispatch.col.scope')}</th><th>{t('dispatch.col.status')}</th>
              <th>{t('dispatch.col.issued')}</th><th>{t('dispatch.col.expires')}</th>
              <th>{t('dispatch.col.consumed')}</th>
            </tr>
          </thead>
          <tbody>
            {tickets.tickets.map((tk) => (
              <tr key={tk.id}>
                <td><code title={tk.id}>{tk.id.slice(0, 8)}…</code></td>
                <td>{tk.policyRuleId ? <code>{tk.policyRuleId}</code> : '—'}</td>
                <td>{scopeText(tk.scope)}</td>
                <td>{tk.status ? <span className="pill">{tk.status}</span> : '—'}</td>
                <td>
                  {tk.issuedBy ?? '—'}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {fmtTime(tk.issuedAt ?? tk.createdAt)}
                  </div>
                </td>
                <td>{tk.expiresAt ? fmtTime(tk.expiresAt) : '—'}</td>
                <td>
                  {tk.consumedAt || tk.consumedByTaskId ? (
                    <>
                      {tk.consumedAt ? fmtTime(tk.consumedAt) : null}
                      {tk.consumedByTaskId && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {t('dispatch.consumedByTask')} <code title={tk.consumedByTaskId}>
                            {tk.consumedByTaskId.slice(0, 8)}…
                          </code>
                        </div>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
