/**
 * Watchdog routes — SPEC_V2 §30 (lives in @ai-factory/watchdog).
 *
 *  POST /api/watchdog/workers                        {workerId, scope?} register
 *  POST /api/watchdog/workers/:id/heartbeat          record a heartbeat
 *  POST /api/watchdog/workers/:id/signals            report worker signals
 *  POST /api/watchdog/tick                           advance the watchdog clock
 *  GET  /api/watchdog/workers/:id                    status + diagnosis
 *  GET  /api/watchdog/workers/:id/diagnosis          diagnosis only
 *  POST /api/watchdog/workers/:id/recover            {action: kill|restart, reason}
 *  GET  /api/watchdog/self                           watchdog self-health
 *
 * NOTE: not wired into index.ts (Wave-3 constraint) — export the installer
 * for the coordinator to mount.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { Watchdog } from '@ai-factory/watchdog';
import type { RouteContext } from './context';

const watchdog = new Watchdog([], {
  policyGate: () => true, // server wiring may inject the real policy engine
  onNotify: (m) => console.warn(`[watchdog] ${m}`),
});

export async function handleWatchdogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/watchdog')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/watchdog'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg[0] === 'workers' && seg.length === 1) {
    const body = await ctx.readBody(req);
    try {
      watchdog.registerWorker(body['workerId'] as string, body['scope'] as string | undefined);
      ctx.json(res, 201, { ok: true });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'workers' && seg[2] === 'heartbeat') {
    try {
      watchdog.heartbeat(seg[1]);
      ctx.json(res, 200, { ok: true });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'workers' && seg[2] === 'signals') {
    const body = await ctx.readBody(req);
    try {
      watchdog.reportSignals(seg[1], (body['signals'] as never) ?? {});
      ctx.json(res, 200, { ok: true });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'tick') {
    ctx.json(res, 200, { statuses: watchdog.tick() });
    return true;
  }

  if (method === 'GET' && seg[0] === 'workers' && seg.length === 2) {
    try {
      ctx.json(res, 200, { status: watchdog.getStatus(seg[1]) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg[0] === 'workers' && seg[2] === 'diagnosis') {
    try {
      ctx.json(res, 200, watchdog.diagnose(seg[1]));
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'workers' && seg[2] === 'recover') {
    const body = await ctx.readBody(req);
    try {
      const rec = watchdog.requestRecovery(
        seg[1],
        body['action'] as 'kill' | 'restart',
        (body['reason'] as string) ?? '',
      );
      ctx.audit.record('api', 'WATCHDOG_RECOVERY', 'worker', seg[1], { action: rec.action });
      ctx.json(res, 200, { recovery: rec });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg[0] === 'self') {
    ctx.json(res, 200, { selfHealth: watchdog.selfHealth() });
    return true;
  }

  return false;
}
