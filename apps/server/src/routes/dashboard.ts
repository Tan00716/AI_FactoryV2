/**
 * Dashboard routes — spec §83.
 *
 *   GET  /api/stats    factory-wide status strip + metric cards (§83)
 *
 * Pure aggregation lives in @ai-factory/dashboard; this module only
 * snapshots the existing stores (tasks, agents, QA runs, deployments,
 * approvals, audit, resource usage) into the DashboardInput shape.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  computeDashboardStats,
  type DashboardInput,
  type OutcomeSnapshot,
} from '@ai-factory/dashboard';
import { listQaRuns } from './qa';
import { listDeployments } from './cicd';
import { resourceInternals } from './resources';
import type { RouteContext } from './context';

/**
 * §1.2 AOCR outcomes — built ONLY from records that actually exist in the
 * stores: one outcome per task in the task store.
 *
 * Mapping (honest coverage — do not widen without a real data source):
 * - authorized := the task has at least one approval record whose
 *   `decision` is 'APPROVED'. The approvals table (task_id + decision) is
 *   the only authorization record in this system, so a task that was never
 *   approved — still pending, rejected, or never submitted — counts as NOT
 *   authorized and never enters AOCR's denominator (the dashboard package
 *   defines the rate over authorized outcomes only).
 * - completed := task.status === 'DONE'.
 * - withinScope / withinBudget / withinRisk are deliberately NOT set: no
 *   store records per-task scope/budget/risk violations, and the dashboard
 *   treats an unrecorded bound as "not violated". Inventing flags here
 *   would fabricate the primary metric's inputs.
 *
 * Coverage: every stored task contributes exactly one outcome row; when no
 * task has an approved approval, AOCR is null (暂无数据), never faked.
 */
function buildOutcomes(
  tasks: ReadonlyArray<{ id: string; status: string }>,
  approvals: ReadonlyArray<{ task_id: string; decision: string }>,
): OutcomeSnapshot[] {
  const approvedTaskIds = new Set(
    approvals.filter((a) => a.decision === 'APPROVED').map((a) => a.task_id),
  );
  return tasks.map((t) => ({
    id: t.id,
    authorized: approvedTaskIds.has(t.id),
    completed: t.status === 'DONE',
  }));
}

export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/stats') return false;
  if (req.method !== 'GET') return true;

  const taskRows = ctx.tasks.list();
  const approvalRows = ctx.fdb.approvals.list();

  const input: DashboardInput = {
    tasks: taskRows.map((t) => ({
      id: t.id,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      completedAt: t.completedAt,
    })),
    agents: ctx.agents.list().map((a) => ({ id: a.id, status: a.status })),
    qaRuns: listQaRuns().map((r) => ({
      id: r.id,
      taskId: r.taskId,
      status: r.status,
      verdict: r.verdict,
      attempts: r.attempts,
    })),
    deployments: listDeployments().map((d) => ({
      id: d.id,
      environment: d.environment,
      status: d.status,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
    })),
    approvals: approvalRows.map((a) => ({
      id: a.approval_id,
      status: a.status,
      decidedBy: a.decided_by,
    })),
    // §1.2 primary metric (AOCR) — real store data, see buildOutcomes().
    outcomes: buildOutcomes(taskRows, approvalRows),
  };

  const summary = resourceInternals().usage.summarize();
  if (summary.records > 0) {
    input.resources = { records: summary.records, totals: summary.totals };
  }

  ctx.json(res, 200, computeDashboardStats(input));
  return true;
}
