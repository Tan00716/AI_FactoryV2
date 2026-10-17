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
import { useLang } from '../i18n';

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
  // i18n 函数别名为 tr：本文件大量回调以 (t) 表示任务行，避免与 t() 冲突。
  const { t: tr, lang } = useLang();
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
        setErr(tr('manager.loadFailed'));
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
  }, [tr]);

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

    const stageName = (key: string): string => tr(`manager.stage.${key}`);

    return [
      mk('receive', stageName('receive'), 'Receive', receive.length, receive.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('assess', stageName('assess'), 'Assess', assess.length, assess.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('plan', stageName('plan'), 'Plan', plan.length, plan.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('select', stageName('select'), 'Select', select.length, select.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk('delegate', stageName('delegate'), 'Delegate', delegate.length, delegate.map((t) => ({ label: taskLabel(t), taskId: t.id }))),
      mk(
        'monitor',
        stageName('monitor'),
        'Monitor',
        monitorRuns.length,
        monitorRuns.map((r) => ({
          label: `run ${r.id.slice(0, 8)} → ${taskById.get(r.taskId)?.title ?? r.taskId}`,
        })),
      ),
      mk(
        'receiveReport',
        stageName('receiveReport'),
        'Receive Report',
        receiveReportRuns.length,
        receiveReportRuns.map((r) => ({
          label: tr('manager.label.runDone', {
            id: r.id.slice(0, 8),
            title: taskById.get(r.taskId)?.title ?? r.taskId,
            status: taskById.get(r.taskId)?.status ?? '?',
          }),
        })),
      ),
      mk(
        'review',
        stageName('review'),
        'Review',
        pendingApprovals.length + reviewTasks.length,
        [
          ...pendingApprovals.map((a) => ({
            label: tr('manager.label.approval', {
              action: a.action ?? a.approval_id,
              taskId: a.task_id ?? '—',
            }),
          })),
          ...reviewTasks.map((t) => ({ label: taskLabel(t), taskId: t.id })),
        ],
      ),
      mk(
        'rework',
        stageName('rework'),
        'Rework/Reassign/Escalate/Approve',
        reworkTasks.length + escalatedRuns.length,
        [
          ...reworkTasks.map((t) => ({ label: taskLabel(t), taskId: t.id })),
          ...escalatedRuns.map((r) => ({ label: tr('manager.label.escalatedRun', { id: r.id.slice(0, 8), taskId: r.taskId }) })),
        ],
      ),
      outboxKnown
        ? mk('aggregate', stageName('aggregate'), 'Aggregate', outboxPending ?? 0, [
            { label: tr('manager.label.outboxPending', { n: outboxPending ?? 0 }) },
          ])
        : mk('aggregate', stageName('aggregate'), 'Aggregate', null, [], tr('manager.noDataHealth')),
      mk('reportUpward', stageName('reportUpward'), 'Report Upward', null, [], tr('manager.noDataReport')),
    ];
  }, [tasks, runs, approvals, outboxPending, outboxKnown, taskById, tr]);

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
        <h3>{tr('manager.title')}</h3>
        <span className="muted">
          {dataReady
            ? tr('manager.headStats', {
                tasks: tasks.length,
                runs: runs?.filter((r) => r.status === 'RUNNING' && r.live).length ?? 0,
                approvals: approvals?.length ?? 0,
              })
            : tr('manager.loading')}
        </span>
      </div>
      {err && <div className="banner err">{err}</div>}

      <h3>{tr('manager.stagesTitle')}</h3>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        {tr('manager.stagesDesc')}
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
              {s.name}
              {lang === 'zh' && (
                <span className="muted" style={{ fontWeight: 400 }}> {s.en}</span>
              )}
            </div>
            <div style={{ fontSize: 22, margin: '6px 0' }}>
              {s.count === null ? <span className="muted">{tr('manager.noData')}</span> : s.count}
              {s.hot && s.count !== null && (
                <span className="err" style={{ fontSize: 12, marginLeft: 8 }}>
                  {tr('manager.bottleneck', { n: BOTTLENECK[s.key] })}
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
              <div className="muted" style={{ fontSize: 11 }}>{tr('manager.moreItems', { count: s.count })}</div>
            )}
          </div>
        ))}
      </div>

      {hotStages.length > 0 && (
        <div className="banner err" style={{ margin: '12px 0' }}>
          {tr('manager.bottleneckBanner', {
            stages: hotStages
              .map((s) => tr('manager.bottleneckItem', { name: s.name, count: s.count ?? 0 }))
              .join(tr('manager.listSep')),
          })}
        </div>
      )}

      {parkedDeployments.length > 0 && (
        <>
          <h3>{tr('manager.pendingDeployments')}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('manager.col.deployment')}</th><th>{tr('manager.col.task')}</th>
                <th>{tr('manager.col.environment')}</th><th>{tr('manager.col.status')}</th>
              </tr>
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

      <h3>{tr('manager.teamTitle')}</h3>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        {tr('manager.teamDesc', { agents: agents.length, active: groups.length })}
      </p>
      {groups.length === 0 ? (
        <p className="muted">{tr('manager.teamEmpty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{tr('manager.col.member')}</th><th>{tr('manager.col.role')}</th>
              <th>{tr('manager.col.task')}</th><th>{tr('manager.col.runningRuns')}</th>
              <th>{tr('manager.col.pendingApprovals')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.agent.id}>
                <td>
                  {g.agent.displayName || g.agent.name}
                  {g.agent.parentAgentId === null && (
                    <span className="pill" style={{ marginLeft: 6 }}>{tr('manager.tier1')}</span>
                  )}
                  <div className="muted" style={{ fontSize: 11 }}><code>{g.agent.id.slice(0, 12)}</code></div>
                </td>
                <td className="muted">{g.agent.jobTitle || '—'}</td>
                <td>
                  {g.tasks.slice(0, 4).map((task) => (
                    <div key={task.id} style={{ fontSize: 12 }}>
                      {task.title}
                      <span className="muted">（{projectName(task.projectId)} · {task.status}）</span>
                    </div>
                  ))}
                  {g.tasks.length > 4 && <div className="muted" style={{ fontSize: 11 }}>{tr('manager.moreItems', { count: g.tasks.length })}</div>}
                  {g.tasks.length === 0 && <span className="muted">—</span>}
                </td>
                <td>
                  {g.runs.slice(0, 4).map((r) => (
                    <div key={r.id} style={{ fontSize: 12 }}>
                      <code>{r.id.slice(0, 8)}</code>
                      <span className="muted"> → {taskById.get(r.taskId)?.title ?? r.taskId}{r.live ? '' : tr('manager.possiblyInterrupted')}</span>
                    </div>
                  ))}
                  {g.runs.length > 4 && <div className="muted" style={{ fontSize: 11 }}>{tr('manager.moreItems', { count: g.runs.length })}</div>}
                  {g.runs.length === 0 && <span className="muted">—</span>}
                </td>
                <td>
                  {g.approvals.slice(0, 4).map((a) => (
                    <div key={a.approval_id} style={{ fontSize: 12 }}>
                      {a.action ?? a.approval_id}
                      <span className="muted">（{a.task_id ?? '—'} · {a.risk_level ?? '—'}）</span>
                    </div>
                  ))}
                  {g.approvals.length > 4 && <div className="muted" style={{ fontSize: 11 }}>{tr('manager.moreItems', { count: g.approvals.length })}</div>}
                  {g.approvals.length === 0 && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 12, fontSize: 11 }}>
        {tr('manager.footnote')}
      </p>
    </div>
  );
}
