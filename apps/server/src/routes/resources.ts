/**
 * Resource routes — spec §79.
 *
 *  GET  /api/resources/usage?taskId=&agentId=&kind=   usage summary
 *  GET  /api/resources/budgets/:taskId                budget / used / remaining
 *  POST /api/resources/consume   {taskId, usage} → 429 when a dimension is exhausted
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  BudgetExceededError,
  BudgetTracker,
  ConcurrencyGate,
  UsageRecorder,
} from '@ai-factory/resources';
import type { BudgetExceededEvent } from '@ai-factory/resources';
import type { RouteContext } from './context';

const tracker = new BudgetTracker({
  onExceed: (event: BudgetExceededEvent) => {
    // eslint-disable-next-line no-console
    console.log('[resources] budget exceeded → escalate', event);
  },
});
const usage = new UsageRecorder();
const gate = new ConcurrencyGate(4);

export function resourceInternals() {
  return { tracker, usage, gate };
}

export async function handleResourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/resources/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/resources/'.length).split('/').filter(Boolean);

  if (method === 'GET' && seg.length === 1 && seg[0] === 'usage') {
    const q = url.searchParams;
    ctx.json(
      res,
      200,
      usage.summarize({
        taskId: q.get('taskId') ?? undefined,
        agentId: q.get('agentId') ?? undefined,
        kind: (q.get('kind') ?? undefined) as never,
      }),
    );
    return true;
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'budgets') {
    const taskId = decodeURIComponent(seg[1] as string);
    try {
      ctx.json(res, 200, {
        taskId,
        remaining: tracker.check(taskId),
        pendingIncreases: tracker.pendingIncreases(taskId),
        gate: gate.stats(),
      });
    } catch (e) {
      ctx.json(res, 404, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'consume') {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'] as string | undefined;
    const use = body['usage'] as Record<string, number> | undefined;
    if (!taskId || !use) {
      ctx.json(res, 400, { error: 'taskId and usage are required' });
      return true;
    }
    try {
      tracker.consume(taskId, use as never);
      ctx.audit.record('system', 'RESOURCE_CONSUMED', 'task', taskId, { usage: use });
      ctx.json(res, 200, { ok: true, remaining: tracker.check(taskId) });
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        ctx.audit.record('system', 'BUDGET_EXCEEDED', 'task', taskId, {
          dimension: (e as { dimension?: string }).dimension,
        });
        ctx.json(res, 429, { error: e.message, dimension: (e as { dimension?: string }).dimension });
      } else {
        ctx.json(res, 400, { error: (e as Error).message });
      }
    }
    return true;
  }

  return false;
}
