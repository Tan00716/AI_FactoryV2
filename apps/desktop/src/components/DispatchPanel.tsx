import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AgentFull,
  type DispatchTask,
  type DispatchTicket,
  type Project,
  type TaskAuthorizationStatus,
} from '../api';

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
function fmtWait(sinceIso: string, now: number): string {
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return '—';
  const min = Math.floor(Math.max(0, now - t) / 60000);
  if (min < 1) return '不足 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
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
        showToast('ok', `${label}「${task.title}」：${res.from} → ${res.to}（服务端已写审计）`);
        setConfirm(null);
        await load();
      } catch (e) {
        const errObj = e as Error & { status?: number };
        showToast(
          'err',
          `${label}「${task.title}」失败（HTTP ${errObj.status ?? '?'}）：${errObj.message}`,
        );
        if (errObj.status === 409) await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, showToast],
  );

  const doDispatch = useCallback(
    (task: DispatchTask) => {
      const f = formFor(task.id);
      if (f.via === 'POLICY' && !f.policyRuleId.trim()) {
        showToast(
          'err',
          'via=POLICY 派发必须填写 policyRuleId：预授权派发须记录触发政策与 Rule ID（服务端同样会以 400 拒绝）。',
        );
        return;
      }
      void act(task, '派发', () =>
        api.dispatchTask(task.id, {
          via: f.via,
          ...(f.assigneeAgentId ? { assigneeAgentId: f.assigneeAgentId } : {}),
          ...(f.via === 'POLICY' ? { policyRuleId: f.policyRuleId.trim() } : {}),
        }),
      );
    },
    [act, formFor, showToast],
  );

  const doReject = useCallback(
    (task: DispatchTask) => {
      const reason = formFor(task.id).reason.trim();
      void act(task, '驳回派发', () =>
        api.rejectDispatch(task.id, reason || undefined),
      );
    },
    [act, formFor],
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

  const taskCell = (t: DispatchTask) => (
    <>
      <td>
        <strong>{t.title}</strong>
        <div className="muted" style={{ fontSize: 11 }}>
          <code title={t.id}>{t.id.slice(0, 8)}…</code> · 工作流状态 {t.status}
        </div>
      </td>
      <td>{projectName(t.projectId)}</td>
      <td>{t.creator}</td>
      <td><span className={`prio ${t.priority.toLowerCase()}`}>{t.priority}</span></td>
    </>
  );

  return (
    <div className="panel">
      <h2>
        Dispatch <span className="muted">人工派发队列 · §17.2 Human Dispatch</span>
      </h2>
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
      {err && <div className="banner err">任务列表不可用：{err}</div>}
      <div className="row">
        <button onClick={() => void load()}>刷新</button>
        {tasks !== null && (
          <span className="muted">
            待派发 {groups.waiting.length} · 草稿 {groups.drafts.length} ·
            已授权 {groups.authorized.length} · 已撤销/过期 {groups.closed.length}
          </span>
        )}
      </div>

      {tasks === null && !err && <p className="muted">Loading tasks…</p>}

      {/* ------------------------------------------------ 待派发队列 */}
      <h3>待派发（WAITING_HUMAN_DISPATCH）</h3>
      {tasks !== null && groups.waiting.length === 0 && (
        <p className="muted">
          当前没有等待人工派发的任务。AI 发现的问题以 WAITING_HUMAN_DISPATCH
          建单、或草稿提交派发后，会出现在这里。
        </p>
      )}
      {groups.waiting.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>任务</th><th>项目</th><th>创建者</th><th>优先级</th>
              <th>等待时长（自最近状态变更）</th><th>派发</th>
            </tr>
          </thead>
          <tbody>
            {groups.waiting.map((t) => {
              const f = formFor(t.id);
              const busy = busyId === t.id;
              return [
                <tr key={t.id}>
                  {taskCell(t)}
                  <td>
                    {fmtWait(t.updatedAt, now)}
                    <div className="muted" style={{ fontSize: 11 }}>
                      变更于 {fmtTime(t.updatedAt)}
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
                      <select
                        aria-label="指派给"
                        value={f.assigneeAgentId}
                        disabled={busy}
                        onChange={(e) => setForm(t.id, { assigneeAgentId: e.target.value })}
                      >
                        <option value="">不指派执行者</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName}（{a.jobTitle}）
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="派发方式 via"
                        value={f.via}
                        disabled={busy}
                        onChange={(e) =>
                          setForm(t.id, { via: e.target.value as 'HUMAN' | 'POLICY' })
                        }
                      >
                        <option value="HUMAN">via: HUMAN（人工派发）</option>
                        <option value="POLICY">via: POLICY（预授权）</option>
                      </select>
                      {f.via === 'POLICY' && (
                        <input
                          type="text"
                          aria-label="policyRuleId"
                          placeholder="policyRuleId（必填）"
                          value={f.policyRuleId}
                          disabled={busy}
                          onChange={(e) => setForm(t.id, { policyRuleId: e.target.value })}
                        />
                      )}
                    </div>
                  </td>
                </tr>,
                <tr key={`${t.id}-actions`}>
                  <td colSpan={6}>
                    <div className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
                      <button disabled={busy} onClick={() => doDispatch(t)}>
                        {busy ? '处理中…' : '派发（授权执行）'}
                      </button>
                      <input
                        type="text"
                        aria-label="驳回原因（可选）"
                        placeholder="驳回原因（可选，进审计）"
                        value={f.reason}
                        disabled={busy}
                        onChange={(e) => setForm(t.id, { reason: e.target.value })}
                      />
                      <button disabled={busy} onClick={() => doReject(t)}>
                        驳回（回草稿）
                      </button>
                      <span className="muted" style={{ fontSize: 11 }}>
                        派发后任务进入 AUTHORIZED 才可被 run 执行；
                        {f.via === 'POLICY'
                          ? ' POLICY 派发的审计 actor 记为 policy，不冒充人工点击。'
                          : ' HUMAN 派发的审计事件为 TASK_DISPATCHED。'}
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
      <h3>草稿（DRAFT）</h3>
      {tasks !== null && groups.drafts.length === 0 && (
        <p className="muted">当前没有草稿任务。草稿是尚未提交派发的任务，不会被执行。</p>
      )}
      {groups.drafts.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>任务</th><th>项目</th><th>创建者</th><th>优先级</th>
              <th>创建时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {groups.drafts.map((t) => (
              <tr key={t.id}>
                {taskCell(t)}
                <td>{fmtTime(t.createdAt)}</td>
                <td>
                  <button
                    disabled={busyId === t.id}
                    onClick={() =>
                      void act(t, '提交派发', () => api.requestDispatch(t.id))
                    }
                  >
                    {busyId === t.id ? '处理中…' : '提交派发'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ---------------------------------------------------- 已授权 */}
      <h3>已授权（AUTHORIZED）— 授权管理</h3>
      {tasks !== null && groups.authorized.length === 0 && (
        <p className="muted">当前没有已授权任务。</p>
      )}
      {groups.authorized.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>任务</th><th>项目</th><th>创建者</th><th>优先级</th>
              <th>当前执行者</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {groups.authorized.map((t) => {
              const busy = busyId === t.id;
              const armed = confirm?.taskId === t.id ? confirm.action : null;
              return [
                <tr key={t.id}>
                  {taskCell(t)}
                  <td>
                    {t.currentAgentId ? (
                      <code title={t.currentAgentId}>{t.currentAgentId.slice(0, 8)}…</code>
                    ) : (
                      <span className="muted">未指派</span>
                    )}
                  </td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() => setConfirm({ taskId: t.id, action: 'revoke' })}
                    >
                      撤销授权…
                    </button>{' '}
                    <button
                      disabled={busy}
                      onClick={() => setConfirm({ taskId: t.id, action: 'expire' })}
                    >
                      标记过期…
                    </button>
                  </td>
                </tr>,
                armed && (
                  <tr key={`${t.id}-confirm`}>
                    <td colSpan={6}>
                      <div className="banner err">
                        {armed === 'revoke' ? (
                          <>
                            确认撤销「{t.title}」的执行授权？撤销后状态变为 REVOKED：
                            该任务立即失去执行资格（发起 run 会被 403 拒绝），且
                            §17.2 未定义从 REVOKED 恢复的路径——无法在本界面重新授权。
                          </>
                        ) : (
                          <>
                            确认把「{t.title}」的授权标记为 EXPIRED？过期后该任务
                            立即失去执行资格（发起 run 会被 403 拒绝），且 §17.2
                            未定义从 EXPIRED 恢复的路径——无法在本界面重新授权。
                          </>
                        )}
                      </div>
                      <div className="row">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              t,
                              armed === 'revoke' ? '撤销授权' : '标记过期',
                              () =>
                                armed === 'revoke'
                                  ? api.revokeAuthorization(t.id)
                                  : api.expireAuthorization(t.id),
                            )
                          }
                        >
                          {busy
                            ? '处理中…'
                            : armed === 'revoke'
                              ? '确认撤销授权'
                              : '确认标记过期'}
                        </button>
                        <button disabled={busy} onClick={() => setConfirm(null)}>
                          取消
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
      <h3>已撤销 / 已过期（REVOKED / EXPIRED）</h3>
      {tasks !== null && groups.closed.length === 0 && (
        <p className="muted">没有被撤销或过期的任务授权。</p>
      )}
      {groups.closed.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>任务</th><th>项目</th><th>创建者</th><th>优先级</th>
                <th>授权状态</th><th>变更时间</th>
              </tr>
            </thead>
            <tbody>
              {groups.closed.map((t) => (
                <tr key={t.id}>
                  {taskCell(t)}
                  <td><span className="pill warn">{authOf(t)}</span></td>
                  <td>{fmtTime(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            §17.2 未定义 REVOKED / EXPIRED 的恢复路径，本面只读呈现，不自创重新授权动作。
          </p>
        </>
      )}

      {/* -------------------------------------------------- 预授权票 */}
      <h3>预授权票（Pre-authorization Tickets）</h3>
      {tickets.phase === 'loading' && <p className="muted">Loading tickets…</p>}
      {tickets.phase === 'not-ready' && (
        <p className="muted">
          服务端票据端点尚未就绪（GET /api/dispatch-tickets 返回 {tickets.status}）：
          预授权票登记册由服务端 Batch 18-1 提供，端点上线前本区不呈现任何票面，
          也不编造数据。当前 POLICY 派发仍可凭 policyRuleId 进行（见待派发区），
          服务端会把 Rule ID 记入审计。
        </p>
      )}
      {tickets.phase === 'error' && (
        <div className="banner err">票据列表不可用：{tickets.message}</div>
      )}
      {tickets.phase === 'ready' && tickets.tickets.length === 0 && (
        <p className="muted">服务端当前没有任何预授权票记录。</p>
      )}
      {tickets.phase === 'ready' && tickets.tickets.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>票据</th><th>Rule ID</th><th>范围</th><th>状态</th>
              <th>签发</th><th>到期</th><th>消费</th>
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
                          任务 <code title={tk.consumedByTaskId}>
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
