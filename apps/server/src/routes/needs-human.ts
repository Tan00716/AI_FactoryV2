/**
 * §81 human-exception-handler upgrade records (Batch 36).
 *
 *   GET  /api/needs-human[?status=open|acknowledged|resolved]   list (viewer)
 *   GET  /api/needs-human/:id                                  one (viewer)
 *   POST /api/needs-human/:id/resolve                          human marks
 *        {resolution: 'acknowledged'|'resolved', resolvedBy?, note?} (operator)
 *
 * Rows are raised by real server paths — currently only AUTHORITY_CONFLICT
 * entering OPEN (the §81 'ai-disagreement' trigger; the other seven §81
 * triggers have no emitter). NOTHING auto-resolves a row: resolving the
 * underlying authority conflict does not touch this table. A human marks
 * the resolution explicitly, which is the only way a row leaves 'open'.
 * Open rows hydrate as-is across restarts (nothing to demote).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { NeedsHumanStatus } from '@ai-factory/db';
import type { RouteContext } from './context';

const VALID_RESOLUTIONS = ['acknowledged', 'resolved'] as const;

export async function handleNeedsHumanRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/needs-human')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/needs-human'.length).split('/').filter(Boolean);

  if (method === 'GET' && seg.length === 0) {
    const status = url.searchParams.get('status');
    if (status !== null && status !== 'open' && status !== 'acknowledged' && status !== 'resolved') {
      ctx.json(res, 400, { error: `unknown status "${status}"` });
      return true;
    }
    const rows = ctx.fdb.needsHuman.list((status ?? undefined) as NeedsHumanStatus | undefined);
    ctx.json(res, 200, { items: rows, total: rows.length });
    return true;
  }

  if (method === 'GET' && seg.length === 1) {
    const row = ctx.fdb.needsHuman.get(seg[0]);
    if (!row) {
      ctx.json(res, 404, { error: 'unknown needs-human upgrade' });
      return true;
    }
    ctx.json(res, 200, { upgrade: row });
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'resolve') {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const resolution = body['resolution'];
    if (resolution !== 'acknowledged' && resolution !== 'resolved') {
      ctx.json(res, 400, {
        error: 'resolution must be "acknowledged" or "resolved"',
      });
      return true;
    }
    const resolvedBy = typeof body['resolvedBy'] === 'string' ? body['resolvedBy'] : null;
    const note = typeof body['note'] === 'string' ? body['note'] : null;
    const row = ctx.fdb.needsHuman.get(seg[0]);
    if (!row) {
      ctx.json(res, 404, { error: 'unknown needs-human upgrade' });
      return true;
    }
    if (row.status !== 'open') {
      // Terminal rows are never rewritten — a human decision is a fact.
      ctx.json(res, 409, {
        error: 'NEEDS_HUMAN_ALREADY_TERMINAL',
        status: row.status,
      });
      return true;
    }
    const ok = ctx.fdb.needsHuman.resolve(
      seg[0],
      resolution,
      resolvedBy,
      note,
      Date.now(),
    );
    if (!ok) {
      // Lost a race with another resolver: the row is terminal now.
      ctx.json(res, 409, {
        error: 'NEEDS_HUMAN_ALREADY_TERMINAL',
      });
      return true;
    }
    ctx.audit.record('system', 'NEEDS_HUMAN_RESOLVED', 'needs-human', seg[0], {
      resolution,
      resolvedBy,
      note,
      source: row.source,
    });
    ctx.json(res, 200, { upgrade: ctx.fdb.needsHuman.get(seg[0]) });
    return true;
  }

  return false;
}
