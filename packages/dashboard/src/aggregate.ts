/**
 * @ai-factory/dashboard — aggregation engine (spec §83).
 *
 * Pure functions: DashboardInput in, DashboardStats out. Time is injectable
 * ({ now }) so tests are deterministic.
 */
import type {
  DashboardInput,
  DashboardMetrics,
  DashboardStatus,
  DashboardStats,
  DeploymentSnapshot,
  OutcomeSnapshot,
  Stat,
} from './types';

export interface Clock {
  now: () => number;
}

const systemClock: Clock = { now: () => Date.now() };

/** §11 terminal states — a task here is no longer active. */
const TERMINAL_STATES = new Set(['DONE', 'CANCELLED', 'REJECTED']);
/** States that count as "blocked" on the status strip. */
const BLOCKED_STATES = new Set(['BLOCKED', 'ESCALATED']);

export const NO_DATA_NOTE = '暂无数据';

function noData(key: string, label: string, source: string, unit?: string): Stat {
  return { key, label, value: null, source, note: NO_DATA_NOTE, ...(unit ? { unit } : {}) };
}

function stat(
  key: string,
  label: string,
  value: number | string,
  source: string,
  unit?: string,
): Stat {
  return { key, label, value, source, ...(unit ? { unit } : {}) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Most recent deployment by (endedAt ?? startedAt ?? '') descending. */
export function latestOf(deployments: DeploymentSnapshot[]): DeploymentSnapshot | null {
  if (deployments.length === 0) return null;
  const ts = (d: DeploymentSnapshot): string => d.endedAt ?? d.startedAt ?? '';
  return [...deployments].sort((a, b) => (ts(b) < ts(a) ? -1 : ts(b) > ts(a) ? 1 : 0))[0];
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${round1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${round1(n / 1_000)}k`;
  return String(n);
}

function computeStatus(input: DashboardInput): DashboardStatus {
  const TASK_SRC = '任务存储 tasks (GET /api/tasks)';
  const AGENT_SRC = '智能体注册表 agents (GET /api/agents)';
  const QA_SRC = 'QA 运行记录 (GET /api/qa/runs)';
  const DEPLOY_SRC = 'CI/CD 部署记录 (GET /api/deployments)';
  const RES_SRC = '资源用量记录 (GET /api/resources/usage)';

  const activeTasks =
    input.tasks.length === 0
      ? noData('activeTasks', '活跃任务', TASK_SRC)
      : stat(
          'activeTasks',
          '活跃任务',
          input.tasks.filter((t) => !TERMINAL_STATES.has(t.status) && !BLOCKED_STATES.has(t.status)).length,
          TASK_SRC,
          '个',
        );

  const blockedTasks =
    input.tasks.length === 0
      ? noData('blockedTasks', '阻塞任务', TASK_SRC)
      : stat(
          'blockedTasks',
          '阻塞任务',
          input.tasks.filter((t) => BLOCKED_STATES.has(t.status)).length,
          TASK_SRC,
          '个',
        );

  const runningAgents =
    input.agents.length === 0
      ? noData('runningAgents', '运行中 Agent', AGENT_SRC)
      : stat(
          'runningAgents',
          '运行中 Agent',
          input.agents.filter((a) => a.status === 'WORKING').length,
          AGENT_SRC,
          '个',
        );

  const qaFailures =
    input.qaRuns.length === 0
      ? noData('qaFailures', 'QA 失败', QA_SRC)
      : stat(
          'qaFailures',
          'QA 失败',
          input.qaRuns.filter((r) => r.status === 'FAILED').length,
          QA_SRC,
          '次',
        );

  const latest = latestOf(input.deployments);
  const latestDeployment =
    latest === null
      ? noData('latestDeployment', '最近部署', DEPLOY_SRC)
      : stat('latestDeployment', '最近部署', `${latest.environment} · ${latest.status}`, DEPLOY_SRC);

  const latestProd =
    latestOf(input.deployments.filter((d) => d.environment === 'PROD'));
  const productionStatus =
    latestProd === null
      ? noData('productionStatus', '生产状态', DEPLOY_SRC)
      : stat('productionStatus', '生产状态', latestProd.status, DEPLOY_SRC);

  const r = input.resources;
  const resourceUsage =
    !r || r.records === 0
      ? noData('resourceUsage', '资源用量', RES_SRC)
      : stat(
          'resourceUsage',
          '资源用量',
          `tokens ${humanTokens(r.totals.tokens)} · 工具调用 ${r.totals.toolCalls} · 耗时 ${r.totals.timeMs}ms`,
          RES_SRC,
        );

  return {
    activeTasks,
    blockedTasks,
    runningAgents,
    qaFailures,
    latestDeployment,
    productionStatus,
    resourceUsage,
  };
}

export interface AocrResult {
  /** Percent (0–100, 1dp) or null when there are no authorized outcomes. */
  ratePercent: number | null;
  authorizedTotal: number;
  authorizedCompleted: number;
}

/**
 * §1.2 — Authorized Outcome Completion Rate (the product's PRIMARY metric):
 * the share of AUTHORIZED outcomes that were completed within scope,
 * budget and risk bounds.
 *
 *   AOCR = |{o : o.authorized ∧ o.completed ∧ within bounds}| / |{o : o.authorized}|
 *
 * Unauthorized outcomes never enter either side (completing unauthorized
 * work does not raise the rate). Denominator 0 → ratePercent is null:
 * unavailable, never a fabricated 100%.
 */
export function computeAuthorizedOutcomeCompletionRate(
  outcomes: readonly OutcomeSnapshot[],
): AocrResult {
  const authorized = outcomes.filter((o) => o.authorized);
  const completed = authorized.filter(
    (o) =>
      o.completed &&
      o.withinScope !== false &&
      o.withinBudget !== false &&
      o.withinRisk !== false,
  );
  return {
    ratePercent:
      authorized.length === 0 ? null : round1((completed.length / authorized.length) * 100),
    authorizedTotal: authorized.length,
    authorizedCompleted: completed.length,
  };
}

function computeMetrics(input: DashboardInput): DashboardMetrics {
  const TASK_SRC = '任务存储 tasks (GET /api/tasks)';
  const QA_SRC = 'QA 运行记录 (GET /api/qa/runs)';
  const DEPLOY_SRC = 'CI/CD 部署记录 (GET /api/deployments)';
  const APPROVAL_SRC = '审批记录 approvals (GET /api/approvals)';

  const OUTCOME_SRC = '获准结果记录 outcomes (§1.2 主指标)';

  // §1.2 PRIMARY metric — AOCR. No authorized outcomes → null + 暂无数据,
  // exactly like every other stat: never invent a rate.
  const aocr = computeAuthorizedOutcomeCompletionRate(input.outcomes ?? []);
  const authorizedOutcomeCompletionRate =
    aocr.ratePercent === null
      ? noData('authorizedOutcomeCompletionRate', '授权结果完成率 (AOCR)', OUTCOME_SRC, '%')
      : stat(
          'authorizedOutcomeCompletionRate',
          '授权结果完成率 (AOCR)',
          aocr.ratePercent,
          OUTCOME_SRC,
          '%',
        );

  const completed = input.tasks.filter((t) => t.status === 'DONE');

  const tasksCompleted =
    input.tasks.length === 0
      ? noData('tasksCompleted', '任务完成数', TASK_SRC)
      : stat('tasksCompleted', '任务完成数', completed.length, TASK_SRC, '个');

  // First-pass success: completed tasks whose QA passed on the first attempt
  // (a run with status COMPLETED and attempts === 1).
  const completedIds = new Set(completed.map((t) => t.id));
  const runsByTask = new Map<string, typeof input.qaRuns>();
  for (const r of input.qaRuns) {
    const list = runsByTask.get(r.taskId) ?? [];
    list.push(r);
    runsByTask.set(r.taskId, list);
  }
  const withQa = completed.filter((t) => (runsByTask.get(t.id) ?? []).length > 0);
  const firstPass = withQa.filter((t) =>
    (runsByTask.get(t.id) ?? []).some((r) => r.status === 'COMPLETED' && r.attempts <= 1),
  );
  const firstPassSuccessRate =
    withQa.length === 0
      ? noData('firstPassSuccessRate', '首过成功率', QA_SRC, '%')
      : stat(
          'firstPassSuccessRate',
          '首过成功率',
          round1((firstPass.length / withQa.length) * 100),
          `${QA_SRC} + ${TASK_SRC}`,
          '%',
        );

  // Average task duration over completed tasks with a completion timestamp.
  const durationsMin = completed
    .filter((t) => t.completedAt !== null)
    .map((t) => (Date.parse(t.completedAt as string) - Date.parse(t.createdAt)) / 60_000)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avgTaskDuration =
    durationsMin.length === 0
      ? noData('avgTaskDuration', '平均任务时长', TASK_SRC, '分钟')
      : stat('avgTaskDuration', '平均任务时长', round1(mean(durationsMin)), TASK_SRC, '分钟');

  // Average repair loops = average (attempts - 1) over completed QA runs.
  const completedRuns = input.qaRuns.filter((r) => r.status === 'COMPLETED');
  const avgRepairLoops =
    completedRuns.length === 0
      ? noData('avgRepairLoops', '平均修复轮数', QA_SRC, '轮')
      : stat(
          'avgRepairLoops',
          '平均修复轮数',
          round2(mean(completedRuns.map((r) => Math.max(0, r.attempts - 1)))),
          QA_SRC,
          '轮',
        );

  const failedDeployments =
    input.deployments.length === 0
      ? noData('failedDeployments', '失败部署数', DEPLOY_SRC)
      : stat(
          'failedDeployments',
          '失败部署数',
          input.deployments.filter((d) => d.status === 'FAILED').length,
          DEPLOY_SRC,
          '次',
        );

  const rollbackCount =
    input.deployments.length === 0
      ? noData('rollbackCount', '回滚数', DEPLOY_SRC)
      : stat(
          'rollbackCount',
          '回滚数',
          input.deployments.filter((d) => d.status === 'ROLLED_BACK').length,
          DEPLOY_SRC,
          '次',
        );

  // Human interventions: approvals decided by a human approver.
  const decidedByHuman = input.approvals.filter(
    (a) => a.decidedBy === 'human' && (a.status === 'APPROVED' || a.status === 'REJECTED'),
  );
  const humanInterventions =
    input.approvals.length === 0
      ? noData('humanInterventions', '人工干预数', APPROVAL_SRC)
      : stat('humanInterventions', '人工干预数', decidedByHuman.length, APPROVAL_SRC, '次');

  return {
    authorizedOutcomeCompletionRate,
    tasksCompleted,
    firstPassSuccessRate,
    avgTaskDuration,
    avgRepairLoops,
    failedDeployments,
    rollbackCount,
    humanInterventions,
  };
}

/** Build the full §83 dashboard payload from store snapshots. */
export function computeDashboardStats(
  input: DashboardInput,
  clock: Clock = systemClock,
): DashboardStats {
  return {
    generatedAt: new Date(clock.now()).toISOString(),
    status: computeStatus(input),
    metrics: computeMetrics(input),
  };
}
