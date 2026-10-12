/**
 * Resource routes — spec §79.
 *
 *  GET  /api/resources/usage?taskId=&agentId=&kind=&from=&to=
 *         usage summary (Dashboard aggregate structure)
 *  GET  /api/resources/budgets/:taskId
 *         task budget, current consumption, remaining, pending increases
 *
 * The server registers this module by passing a router and its dependencies:
 *
 *   import { registerResourceRoutes } from '@ai-factory/resources';
 *   registerResourceRoutes(serverRouter, { tracker, usage });
 *
 * where serverRouter.get(path, handler) wraps a handler of the shape below
 * (path params are exposed as req.params, query strings as req.query).
 */

import { BudgetTracker } from './tracker';
import { UsageRecorder, SummarizeFilter } from './usage';
import { USAGE_RECORD_KINDS, UsageRecordKind } from './types';

export interface ResourceHttpRequest {
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface ResourceHttpResponse {
  status: number;
  body: unknown;
}

export interface ResourceRouter {
  get(path: string, handler: (req: ResourceHttpRequest) => ResourceHttpResponse): void;
}

/** Deps are intentionally loose: any object with these two fields works. */
export interface ResourceRouteDeps {
  tracker: BudgetTracker;
  usage: UsageRecorder;
}

const USAGE_KINDS: readonly string[] = USAGE_RECORD_KINDS;

function ok(body: unknown): ResourceHttpResponse {
  return { status: 200, body };
}

function notFound(message: string): ResourceHttpResponse {
  return { status: 404, body: { error: message } };
}

function badRequest(message: string): ResourceHttpResponse {
  return { status: 400, body: { error: message } };
}

export function registerResourceRoutes(router: ResourceRouter, deps: ResourceRouteDeps): void {
  const { tracker, usage } = deps;

  // GET /api/resources/usage?taskId=&agentId=&kind=&from=&to=
  router.get('/api/resources/usage', (req) => {
    const { taskId, agentId, kind, from, to } = req.query;
    if (kind !== undefined && !(USAGE_KINDS as readonly string[]).includes(kind)) {
      return badRequest(`kind must be one of: ${USAGE_KINDS.join(', ')}`);
    }
    const filter: SummarizeFilter = {};
    if (taskId !== undefined) filter.taskId = taskId;
    if (agentId !== undefined) filter.agentId = agentId;
    if (kind !== undefined) filter.kind = kind as UsageRecordKind;
    if (from !== undefined) {
      const n = Number(from);
      if (!Number.isFinite(n)) return badRequest('from must be an epoch-millis number');
      filter.from = n;
    }
    if (to !== undefined) {
      const n = Number(to);
      if (!Number.isFinite(n)) return badRequest('to must be an epoch-millis number');
      filter.to = n;
    }
    return ok({ summary: usage.summarize(filter) });
  });

  // GET /api/resources/budgets/:taskId
  router.get('/api/resources/budgets/:taskId', (req) => {
    const taskId = req.params['taskId'];
    if (!taskId) return badRequest('taskId is required');
    return ok({
      taskId,
      budget: tracker.getBudget(taskId),
      used: tracker.usage(taskId),
      remaining: tracker.check(taskId),
      /** §21.4/§27.1: measurements whose amount is unknown, counted
       *  separately — never folded into `used`. */
      unknown: tracker.unknownUsage(taskId),
      reservations: tracker.listReservations(taskId),
      pendingIncreases: tracker.pendingIncreases(taskId),
    });
  });
}
