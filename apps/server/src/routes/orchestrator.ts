/**
 * Orchestrator routes — spec §92–§95, §21.
 *
 *  POST /api/orchestrator/decompose   {title, goal, kind, constraints?}
 *  POST /api/orchestrator/schedule    {items: [{id, priority, dependsOn?}],
 *                                      concurrencyLimit?} → execution order
 *  POST /api/orchestrator/select      {requiredSkills?, requiredTools?,
 *                                      requiredPermissions?, complexity?,
 *                                      agentIds?} → ranked agents
 *  POST /api/orchestrator/next-action {status, evidence?, failures?}
 *  POST /api/orchestrator/pattern     {subtaskCount, fanOut?} → manager|handoff
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleOrchestratorRoutes } from './routes/orchestrator';
 *   if (await handleOrchestratorRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  Scheduler,
  choosePattern,
  decideNextAction,
  decompose,
  rankCandidates,
} from '@ai-factory/orchestrator';
import type { Permission } from '@ai-factory/core';
import type { RouteContext } from './context';

const VALID_KINDS = new Set(['bugfix', 'feature', 'refactor', 'research']);
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

export async function handleOrchestratorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/orchestrator/')) return false;

  if (method === 'POST' && path === '/api/orchestrator/decompose') {
    const b = await ctx.readBody(req);
    const { title, goal, kind } = b;
    if (
      typeof title !== 'string' ||
      typeof goal !== 'string' ||
      typeof kind !== 'string' ||
      !VALID_KINDS.has(kind)
    ) {
      ctx.json(res, 400, {
        error: 'title, goal and kind (bugfix|feature|refactor|research) are required',
      });
      return true;
    }
    const plan = decompose({
      title,
      goal,
      kind: kind as 'bugfix' | 'feature' | 'refactor' | 'research',
      constraints: Array.isArray(b['constraints'])
        ? (b['constraints'] as string[])
        : undefined,
    });
    return ctx.json(res, 200, plan), true;
  }

  if (method === 'POST' && path === '/api/orchestrator/schedule') {
    const b = await ctx.readBody(req);
    const items = b['items'];
    if (!Array.isArray(items)) {
      ctx.json(res, 400, { error: 'items[] is required' });
      return true;
    }
    for (const it of items) {
      const r = it as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || !VALID_PRIORITIES.has(r['priority'] as string)) {
        ctx.json(res, 400, {
          error: 'each item needs id (string) and priority (P0|P1|P2|P3)',
        });
        return true;
      }
    }
    const scheduler = new Scheduler({
      concurrencyLimit:
        typeof b['concurrencyLimit'] === 'number'
          ? (b['concurrencyLimit'] as number)
          : 4,
    });
    for (const it of items) {
      const r = it as Record<string, unknown>;
      scheduler.enqueue({
        id: r['id'] as string,
        priority: r['priority'] as 'P0' | 'P1' | 'P2' | 'P3',
        dependsOn: Array.isArray(r['dependsOn'])
          ? (r['dependsOn'] as string[])
          : [],
      });
    }
    // Drain the queue into deterministic execution order.
    const order: string[] = [];
    let guard = items.length * 4 + 10;
    while (guard-- > 0) {
      const batch = scheduler.nextBatch();
      if (batch.length === 0) break;
      for (const id of batch) {
        order.push(id);
        scheduler.finish(id);
      }
    }
    return ctx.json(res, 200, { order }), true;
  }

  if (method === 'POST' && path === '/api/orchestrator/select') {
    const b = await ctx.readBody(req);
    const all = ctx.agents.list();
    const ids = b['agentIds'];
    const agents = Array.isArray(ids)
      ? all.filter((a) => (ids as string[]).includes(a.id))
      : all;
    const ranked = rankCandidates(agents, {
      requiredSkills: Array.isArray(b['requiredSkills'])
        ? (b['requiredSkills'] as string[])
        : [],
      requiredTools: Array.isArray(b['requiredTools'])
        ? (b['requiredTools'] as string[])
        : [],
      requiredPermissions: Array.isArray(b['requiredPermissions'])
        ? (b['requiredPermissions'] as Permission[])
        : [],
      complexity:
        typeof b['complexity'] === 'number'
          ? (Math.min(5, Math.max(1, b['complexity'] as number)) as 1 | 2 | 3 | 4 | 5)
          : 3,
    });
    return ctx.json(res, 200, { candidates: ranked }), true;
  }

  if (method === 'POST' && path === '/api/orchestrator/next-action') {
    const b = await ctx.readBody(req);
    if (typeof b['status'] !== 'string') {
      ctx.json(res, 400, { error: 'status is required' });
      return true;
    }
    try {
      const action = decideNextAction({
        status: b['status'] as never,
        evidence: Array.isArray(b['evidence']) ? (b['evidence'] as string[]) : [],
        failures: typeof b['failures'] === 'number' ? (b['failures'] as number) : 0,
      });
      return ctx.json(res, 200, { action }), true;
    } catch (e) {
      ctx.json(res, 400, { error: e instanceof Error ? e.message : 'bad status' });
      return true;
    }
  }

  if (method === 'POST' && path === '/api/orchestrator/pattern') {
    const b = await ctx.readBody(req);
    const pattern = choosePattern({
      subtaskCount: typeof b['subtaskCount'] === 'number' ? (b['subtaskCount'] as number) : 1,
      fanOut: b['fanOut'] === true,
      sequentialPipeline: b['sequentialPipeline'] === true,
    });
    return ctx.json(res, 200, { pattern }), true;
  }

  return false;
}
