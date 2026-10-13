/** §29.3 Manager Team View + §12 管理循环（Management Runtime）。
 *
 *  本面只做聚合呈现，不产生新事实：
 *  - 12 阶段走查：按 §12.1 原文链 `Receive → Assess → Plan → Select →
 *    Delegate → Monitor → Receive Report → Review → Rework/Reassign/
 *    Escalate/Approve → Aggregate → Report Upward` 逐阶段卡片化，每个阶段
 *    的"卡住"定义是前端常量 MAPPING（本地口径，见下方），不是规格公式；
 *    无数据源的阶段如实显示"无数据"，不编造。
 *  - Manager Team：按 agent 分组其任务 / 进行中 run / 待其审批。
 *  - 瓶颈提示：阈值是前端常量 BOTTLENECK（本地口径），超阈值标黄/红。
 *  服务端未新增任何端点：用的都是已有的 /tasks、/runtime/runs、
 *  /approvals?status=PENDING、/deployments、/health、/agents。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  AgentFull,
  DeploymentRecord,
  DispatchTask,
  Project,
  QueueApproval,
  RuntimeRunListItem,
} from '../api';

/** v1 workflow 终态（卡住统计时排除）。 */
const TERMINAL = new Set(['DONE', 'CANCELLED']);
/** 异常态（§11 exception states）：Rework/Reassign/Escalate/Approve 阶段。 */
const EXCEPTION = new Set([
  'BLOCKED',
  'QA_FAILED',
  'UAT_FAILED',
  'PROD_FAILED',
  'ROLLBACK',
  'REJECTED',
]);
const REVIEW_STATES = new Set(['CODE_REVIEW', 'PENDING_QA', 'QA']);

/**
 * 各阶段的本地口径映射（前端常量，非规格公式）。
 * 规格 §12.1 只给了阶段链，没有给"卡住"的判定公式——
 * 每个阶段的计数规则是本面板按数据可得性做的解释，面板底部如实注明。
 */
const STAGES = [
  { key: 'receive', name: '接收', en: 'Receive' },
  { key: 'assess', name: '评估', en: 'Assess' },
  { key: 'plan', name: '计划', en: 'Plan' },
  { key: 'select', name: '选人', en: 'Select' },
  { key: 'delegate', name: '委托', en: 'Delegate' },
  { key: 'monitor', name: '监控', en: 'Monitor' },
  { key: 'receiveReport', name: '收报告', en: 'Receive Report' },
  { key: 'review', name: '评审', en: 'Review' },
  { key: 'rework', name: '返工/改派/升级/批准', en: 'Rework/Reassign/Escalate/Approve' },
  { key: 'aggregate', name: '汇总', en: 'Aggregate' },
  { key: 'reportUpward', name: '上报', en: 'Report Upward' },
] as const;

/** 瓶颈阈值：前端常量，本地口径，非规格公式。 */
const BOTTLENECK: Record<string, number> = {
  receive: 5,
  assess: 5,
  plan: 10,
  select: 5,
  delegate: 10,
  monitor: 20,
  receiveReport: 5,
  review: 5,
  rework: 1,
  aggregate: 20,
};

interface StageItem {
  label: string;
  taskId?: string;
}
interface StageView {
  key: string;
  name: string;
  en: string;
  /** null = 该阶段无数据源，如实显示"无数据"。 */
  count: number | null;
  items: StageItem[];
  hot: boolean;
  noDataReason?: string;
}

function authOf(t: DispatchTask): string {
  return t.authorizationStatus ?? 'AUTHORIZED';
}

function taskLabel(t: DispatchTask): string {
  return `${t.title}（${t.status}）`;
}

export function ManagerPanel() {
  const [tasks, setTasks] = useState<DispatchTask[] | null>(null);
  const [runs, setRuns] = useState<RuntimeRunListItem[] | null>(null);
  const [approvals, setApprovals] = useState<QueueApproval[] | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[] | null>(null);
  const [outboxPending, setOutboxPending] = useState<number | null>(null);
  const [outboxKnown, setOutboxKnown] = useState(true);
  const [agents, setAgents] = useState<AgentFull[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const settled = await Promise.allSettled([
        api.dispatchTasks(),
        api.runs(),
        api.approvalsQueue(),
        api.deployments(),
        api.health(),
        api.agents(),
        api.projects(),
      ]);
      if (!alive) return;
      const pick = <T,>(i: number): T | null =>
        settled[i].status === 'fulfilled'
          ? (settled[i] as PromiseFulfilledResult<T>).value
          : null;
      const t = pick<DispatchTask[]>(0);
      const r = pick<{ runs: RuntimeRunListItem[] }>(1);
      const a = pick<{ status: number; body: QueueApproval[] }>(2);
      const d = pick<DeploymentRecord[]>(3);
      const h = pick<{ ok: boolean; outbox?: { pending?: number } }>(4);
      if (t === null && r === null && a === null) {
        setErr('管理数据拉取失败（任务/run/审批三个核心源都不可达），请检查服务端是否在运行。');
        return;
      }
      setTasks(t ?? []);
      setRuns(r ? r.runs ?? [] : []);
      setApprovals(a && a.status === 200 && Array.isArray(a.body) ? a.body : []);
      setDeployments(d ?? []);
      if (h && typeof h.outbox?.pending === 'number') {
        setOutboxPending(h.outbox.pending);
      } else {
        setOutboxKnown(false);
      }
      setAgents(pick<AgentFull[]>(5) ?? []);
      setProjects(pick<Project[]>(6) ?? []);
    })().catch((e) => alive && setErr(String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id;
  }, [projects]);

  const taskById = useMemo(() => {
    const m = new Map<string, DispatchTask>();
    for (const t of tasks ?? []) m.set(t.id, t);
    return m;
  }, [tasks]);

  const stages: StageView[] = useMemo(() => {
    const ts = tasks ?? [];
    const rs = runs ?? [];
    const liveRunTaskIds = new Set(
      rs.filter((r) => r.status === 'RUNNING' && r.live).map((r) => r.taskId),
    );
    const runningRunTaskIds = new Set(
      rs.filter((r) => r.status === 'RUNNING').map((r) => r.taskId),
    );
    const sample = (list: StageItem[]) => list.slice(0, 5);

    const receive = ts.filter((t) => authOf(t) === 'DRAFT' && !TERMINAL.has(t.status));
    const assess = ts.filter((t) => authOf(t) === 'WAITING_HUMAN_DISPATCH');
    const plan = ts.filter((t) => t.status === 'PLANNING');
    const select = ts.filter(
      (t) =>
        authOf(t) === 'AUTHORIZED' &&
        (t.assignedAgentIds ?? []).length === 0 &&
        !TERMINAL.has(t.status),
    );
    const delegate = ts.filter(
      (t) =>
        (t.assignedAgentIds ?? []).length > 0 &&
        !runningRunTaskIds.has(t.id) &&
        !TERMINAL.has(t.status),
    );
    const monitorRuns = rs.filter((r) => r.status === 'RUNNING' && r.live);
    const receiveReportRuns = rs.filter((r) => {
      if (r.status !== 'COMPLETED') return false;
      const t = taskById.get(r.taskId);
      return !!t && !TERMINAL.has(t.status) && !EXCEPTION.has(t.status);
    });
    const reviewTasks = ts.filter((t) => REVIEW_STATES.has(t.status));
    const pendingApprovals = approvals ?? [];
    const reworkTasks = ts.filter((t) => EXCEPTION.has(t.status));
    const escalatedRuns = rs.filter((r) => r.status === 'ESCALATED');

    const mk = (
      key: (typeof STAGES)[number]['key'],
      name: string,
      en: string,
      count: number | null,
      items: StageItem[],
      noDataReason?: string,
    ): StageView => ({
      key,
      name,
      en,
      count,
      items: sample(items),
      hot: count !== null && count >= (BOTTLENECK[key] ?? Infinity),
      noDataReason,
    });

    return [
      mk('receive', '接收', 'Receive', receive.length, receive.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('assess', '评估', 'Assess', assess.length, assess.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('plan', '计划', 'Plan', plan.length, plan.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('select', '选人', 'Select', select.length, select.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('delegate', '委托', 'Delegate', delegate.length, delegate.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk(
        'monitor',
        '监控',
        'Monitor',
        monitorRuns.length,
        monitorRuns.map((r) => ({
          label: `run ${r.id.slice(0, 8)} → ${taskById.get(r.taskId)?.title ?? r.taskId}`,
        })),
      ),
      mk(
        'receiveReport',
        '收报告',
        'Receive Report',
        receiveReportRuns.length,
        receiveReportRuns.map((r) => ({
          label: `run ${r.id.slice(0, 8)} 已完 → ${taskById.get(r.taskId)?.title ?? r.taskId} 仍在 ${taskById.get(r.taskId)?.status ?? '?'}`,
        })),
      ),
      mk(
        'review',
        '评审',
        'Review',
        pendingApprovals.length + reviewTasks.length,
        [
          ...pendingApprovals.map((a) => ({
            label: `审批 ${a.action ?? a.approval_id}（${a.task_id ?? '—'}）`,
          })),
          ...reviewTasks.map((t) => ({ label: taskLabel(t), taskId: t.id })),
        ],
      ),
      mk(
        'rework',
        '返工/改派/升级/批准',
        'Rework/Reassign/Escalate/Approve',
        reworkTasks.length + escalatedRuns.length,
        [
          ...reworkTasks.map((t) => ({ label: taskLabel(t), taskId: t.id })),
          ...escalatedRuns.map((r) => ({ label: `升级 run ${r.id.slice(0, 8)}（${r.taskId}）` })),
        ],
      ),
      outboxKnown
        ? mk('aggregate', '汇总', 'Aggregate', outboxPending ?? 0, [
            { label: `outbox 待派发事件 ${outboxPending ?? 0} 条（/api/health）` },
          ])
        : mk('aggregate', '汇总', 'Aggregate', null, [], '健康接口未给出 outbox.pending'),
      mk('reportUpward', '上报', 'Report Upward', null, [], '无全局上报聚合端点（final report 为 per-task，无全量列表）'),
    ];
  }, [tasks, runs, approvals, outboxPending, outboxKnown, taskById]);

  /** Manager Team 分组（§29.3 drill-down 口径的桌面简化版）。 */
  const groups = useMemo(() => {
    const ts = tasks ?? [];
    const rs = runs ?? [];
    const ps = approvals ?? [];
    return agents
      .map((a) => {
        const myTasks = ts.filter(
          (t) => t.currentAgentId === a.id || (t.assignedAgentIds ?? []).includes(a.id),
        );
        const myRuns = rs.filter(
          (r) => r.agentId === a.id && r.status === 'RUNNING',
        );
        const myApprovals = ps.filter((p) =>
          (p.required_approvers ?? []).some(
            (e) =>
              e === a.id ||
              e === a.name ||
              e === a.displayName ||
              e === 'agent' ||
              e.startsWith('agent:'),
          ),
        );
        const total = myTasks.length + myRuns.length + myApprovals.length;
        return { agent: a, tasks: myTasks, runs: myRuns, approvals: myApprovals, total };
      })
      .filter((g) => g.total > 0)
      .sort((x, y) => {
        const xm = x.agent.parentAgentId === null ? 0 : 1;
        const ym = y.agent.parentAgentId === null ? 0 : 1;
        return xm - ym || y.total - x.total;
      });
  }, [agents, tasks, runs, approvals]);

  const parkedDeployments = useMemo(
    () => (deployments ?? []).filter((d) => d.status === 'AWAITING_APPROVAL'),
    [deployments],
  );

  const hotStages = stages.filter((s) => s.hot);
  const dataReady = tasks !== null;

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h3>管理 · Manager Team View（§29.3 / §12）</h3>
        <span className="muted">
          {dataReady
            ? `任务 ${tasks.length} · 运行中 run ${runs?.filter((r) => r.status === 'RUNNING' && r.live).length ?? 0} · 待审批 ${approvals?.length ?? 0}`
            : '加载中…'}
        </span>
      </div>
      {err && <div className="banner err">{err}</div>}

      <h3>12 阶段走查（§12.1）</h3>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        各阶段计数规则是本面板的本地口径（前端常量，非规格公式）；无数据源的阶段如实显示「无数据」。
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {stages.map((s) => (
          <div
            key={s.key}
            className="pill"
            style={{
              padding: '10px 12px',
              borderColor: s.hot ? 'var(--red)' : undefined,
              background: s.hot ? 'rgba(255,80,80,0.06)' : undefined,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {s.name} <span className="muted" style={{ fontWeight: 400 }}>{s.en}</span>
            </div>
            <div style={{ fontSize: 22, margin: '6px 0' }}>
              {s.count === null ? <span className="muted">无数据</span> : s.count}
              {s.hot && s.count !== null && (
                <span className="err" style={{ fontSize: 12, marginLeft: 8 }}>
                  瓶颈（≥{BOTTLENECK[s.key]}）
                </span>
              )}
            </div>
            {s.noDataReason ? (
              <div className="muted" style={{ fontSize: 11 }}>{s.noDataReason}</div>
            ) : (
              s.items.map((it, i) => (
                <div key={i} className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {it.taskId ? <code>{it.taskId.slice(0, 8)}</code> : null} {it.label}
                </div>
              ))
            )}
            {s.count !== null && s.count > s.items.length && (
              <div className="muted" style={{ fontSize: 11 }}>…等共 {s.count} 项</div>
            )}
          </div>
        ))}
      </div>

      {hotStages.length > 0 && (
        <div className="banner err" style={{ margin: '12px 0' }}>
          瓶颈提示：{hotStages.map((s) => `${s.name}（${s.count}）`).join('、')}
          ——阈值为前端本地口径（见代码 BOTTLENECK），非规格公式。
        </div>
      )}

      {parkedDeployments.length > 0 && (
        <>
          <h3>待审批部署</h3>
          <table className="data-table">
            <thead>
              <tr><th>部署</th><th>任务</th><th>环境</th><th>状态</th></tr>
            </thead>
            <tbody>
              {parkedDeployments.map((d) => (
                <tr key={d.id}>
                  <td><code>{String(d.id).slice(0, 12)}</code></td>
                  <td>{d.taskId ?? '—'}</td>
                  <td>{d.environment ?? '—'}</td>
                  <td>{d.status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Manager Team（按 agent 分组）</h3>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        共 {agents.length} 位 agent，{groups.length} 位有在办事项；一级 manager（无上级）排前。
        待审批匹配规则：审批的 required_approvers 命中该 agent 的 id/名，或条目为 agent 通配。
      </p>
      {groups.length === 0 ? (
        <p className="muted">无数据：没有 agent 持有任务、运行中 run 或待审批项。</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>成员</th><th>角色</th><th>任务</th><th>进行中 run</th><th>待其审批</th></tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.agent.id}>
                <td>
                  {g.agent.displayName || g.agent.name}
                  {g.agent.parentAgentId === null && (
                    <span className="pill" style={{ marginLeft: 6 }}>一级</span>
                  )}
                  <div className="muted" style={{ fontSize: 11 }}><code>{g.agent.id.slice(0, 12)}</code></div>
                </td>
                <td className="muted">{g.agent.jobTitle || '—'}</td>
                <td>
                  {g.tasks.slice(0, 4).map((t) => (
                    <div key={t.id} style={{ fontSize: 12 }}>
                      {t.title}
                      <span className="muted">（{projectName(t.projectId)} · {t.status}）</span>
                    </div>
                  ))}
                  {g.tasks.length > 4 && <div className="muted" style={{ fontSize: 11 }}>…等共 {g.tasks.length} 项</div>}
                  {g.tasks.length === 0 && <span className="muted">—</span>}
                </td>
                <td>
                  {g.runs.slice(0, 4).map((r) => (
                    <div key={r.id} style={{ fontSize: 12 }}>
                      <code>{r.id.slice(0, 8)}</code>
                      <span className="muted"> → {taskById.get(r.taskId)?.title ?? r.taskId}{r.live ? '' : '（疑似已中断）'}</span>
                    </div>
                  ))}
                  {g.runs.length > 4 && <div className="muted" style={{ fontSize: 11 }}>…等共 {g.runs.length} 项</div>}
                  {g.runs.length === 0 && <span className="muted">—</span>}
                </td>
                <td>
                  {g.approvals.slice(0, 4).map((a) => (
                    <div key={a.approval_id} style={{ fontSize: 12 }}>
                      {a.action ?? a.approval_id}
                      <span className="muted">（{a.task_id ?? '—'} · {a.risk_level ?? '—'}）</span>
                    </div>
                  ))}
                  {g.approvals.length > 4 && <div className="muted" style={{ fontSize: 11 }}>…等共 {g.approvals.length} 项</div>}
                  {g.approvals.length === 0 && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 12, fontSize: 11 }}>
        数据口径：任务/授权来自 /api/tasks，run 来自 /api/runtime/runs，审批来自
        /api/approvals?status=PENDING，部署来自 /api/deployments，outbox 待派发来自
        /api/health。阶段映射与瓶颈阈值为本面板本地口径（代码中 STAGES/BOTTLENECK
        常量），非规格公式；§12.1 原文阶段链为 Receive → Assess → Plan → Select →
        Delegate → Monitor → Receive Report → Review → Rework/Reassign/Escalate/
        Approve → Aggregate → Report Upward。
      </p>
    </div>
  );
}
