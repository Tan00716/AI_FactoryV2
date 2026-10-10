/**
 * Coordination routes — spec §61–§63.
 *
 *  POST /api/coordination/schedule   {tasks, edges?, maxConcurrency?} → parallel batches (409 on cycle)
 *  POST /api/coordination/overlap    {a, b, strategy?} → overlap report + coordination plan
 *  POST /api/coordination/locks      {kind, key, holder, ttlMs} → acquire
 *  DELETE /api/coordination/locks/:token → release
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  LockManager,
  ScheduleCycleError,
  detectOverlap,
  resolveOverlap,
  schedule,
} from '@ai-factory/coordination';
import type { RouteContext } from './context';

const locks = new LockManager();

export async function handleCoordinationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/coordination/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/coordination/'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'schedule') {
    const body = await ctx.readBody(req);
    const tasks = body['tasks'] as string[] | undefined;
    if (!Array.isArray(tasks)) {
      ctx.json(res, 400, { error: 'tasks (string[]) is required' });
      return true;
    }
    try {
      const result = schedule(
        {
          tasks,
          edges: (body['edges'] as never) ?? [],
        },
        { maxConcurrency: typeof body['maxConcurrency'] === 'number' ? body['maxConcurrency'] : undefined },
      );
      ctx.json(res, 200, result);
    } catch (e) {
      if (e instanceof ScheduleCycleError) {
        ctx.json(res, 409, { error: e.message });
      } else {
        ctx.json(res, 400, { error: (e as Error).message });
      }
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'overlap') {
    const body = await ctx.readBody(req);
    const a = body['a'] as string[] | undefined;
    const b = body['b'] as string[] | undefined;
    if (!Array.isArray(a) || !Array.isArray(b)) {
      ctx.json(res, 400, { error: 'a and b (string[]) are required' });
      return true;
    }
    const report = detectOverlap(a, b);
    const plan = resolveOverlap(report, (body['strategy'] as 'warn' | 'serialize' | 'partition' | 'merge_test' | undefined) ?? 'warn');
    ctx.json(res, 200, { report, plan });
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'locks') {
    const body = await ctx.readBody(req);
    const { kind, key, holder, ttlMs } = body as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof key !== 'string' || typeof holder !== 'string') {
      ctx.json(res, 400, { error: 'kind, key and holder are required' });
      return true;
    }
    const outcome = locks.acquire(kind as never, key, holder, typeof ttlMs === 'number' ? ttlMs : 60000);
    ctx.audit.record(String(holder), 'LOCK_ACQUIRE', 'lock', `${kind}:${key}`, { granted: (outcome as { granted?: boolean }).granted });
    ctx.json(res, 200, outcome);
    return true;
  }

  if (method === 'DELETE' && seg.length === 2 && seg[0] === 'locks') {
    const released = locks.release(decodeURIComponent(seg[1] as string));
    ctx.json(res, 200, { released });
    return true;
  }

  return false;
}
