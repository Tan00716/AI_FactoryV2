/**
 * System Event Bus routes — spec §91.
 *
 *  GET  /api/events?type=&limit=   recent bus events (newest first), for UI polling
 *  POST /api/events/emit           {type, payload?, source?} — internal producers;
 *                                 also used by tests/demos
 *
 * The bus instance lives in the RouteContext (created once in index.ts).
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleEventRoutes } from './routes/events';
 *   if (await handleEventRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { EVENT_TYPES } from '@ai-factory/events';
import type { RouteContext } from './context';

export async function handleEventRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/events')) return false;

  if (method === 'GET' && path === '/api/events') {
    const type = url.searchParams.get('type') ?? undefined;
    const limit = Math.min(
      500,
      Math.max(1, Number(url.searchParams.get('limit') ?? 100)),
    );
    if (type !== undefined && !EVENT_TYPES.includes(type as never)) {
      ctx.json(res, 400, { error: `unknown event type: ${type}` });
      return true;
    }
    return ctx.json(res, 200, {
      events: ctx.bus.recent(limit, type),
      total: ctx.bus.count(),
      types: EVENT_TYPES,
    }), true;
  }

  if (method === 'POST' && path === '/api/events/emit') {
    const b = await ctx.readBody(req);
    const type = b['type'];
    const source = typeof b['source'] === 'string' ? b['source'] : 'api';
    if (typeof type !== 'string' || !type) {
      ctx.json(res, 400, { error: 'type (non-empty string) is required' });
      return true;
    }
    try {
      const event = ctx.bus.emit(type, b['payload'], source);
      return ctx.json(res, 201, event), true;
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
      return true;
    }
  }

  return false;
}
