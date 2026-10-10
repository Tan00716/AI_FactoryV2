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
} from '@ai-factory/dashboard';
import { listQaRuns } from './qa';
import { listDeployments } from './cicd';
import { resourceInternals } from './resources';
import type { RouteContext } from './context';

export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/stats') return false;
  if (req.method !== 'GET') return true;

  const input: DashboardInput = {
    tasks: ctx.tasks.list().map((t) => ({
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
    approvals: ctx.fdb.approvals.list().map((a) => ({
      id: a.approval_id,
      status: a.status,
      decidedBy: a.decided_by,
    })),
  };

  const summary = resourceInternals().usage.summarize();
  if (summary.records > 0) {
    input.resources = { records: summary.records, totals: summary.totals };
  }

  ctx.json(res, 200, computeDashboardStats(input));
  return true;
}
