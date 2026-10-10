/**
 * Recovery routes — spec §77–§78.
 *
 *  POST /api/recovery/snapshots            {dir, tag?, dbPath?} → snapshot manifest
 *  GET  /api/recovery/snapshots            list snapshots
 *  POST /api/recovery/snapshots/:id/restore {dir?} → restore (backs up current first)
 *  POST /api/recovery/classify             {message, context?} → failure type + recommended strategy
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import {
  SnapshotStore,
  classifyFailure,
  selectStrategy,
} from '@ai-factory/recovery';
import type { RouteContext } from './context';

const store = new SnapshotStore(join(process.cwd(), 'data', 'snapshots'));

export async function handleRecoveryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/recovery/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/recovery/'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'snapshots') {
    const body = await ctx.readBody(req);
    const dir = body['dir'] as string | undefined;
    if (!dir) {
      ctx.json(res, 400, { error: 'dir is required' });
      return true;
    }
    try {
      const manifest = store.take(dir, {
        tag: typeof body['tag'] === 'string' ? body['tag'] : undefined,
        dbPath: typeof body['dbPath'] === 'string' ? body['dbPath'] : undefined,
      });
      ctx.audit.record('system', 'SNAPSHOT_TAKEN', 'snapshot', manifest.id, { tag: manifest.tag });
      ctx.json(res, 201, manifest);
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1 && seg[0] === 'snapshots') {
    ctx.json(res, 200, { snapshots: store.list() });
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'snapshots' && seg[2] === 'restore') {
    const body = await ctx.readBody(req);
    try {
      const result = store.restore(decodeURIComponent(seg[1] as string), typeof body['dir'] === 'string' ? body['dir'] : undefined);
      ctx.audit.record('system', 'SNAPSHOT_RESTORED', 'snapshot', decodeURIComponent(seg[1] as string), {});
      ctx.json(res, 200, result);
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'classify') {
    const body = await ctx.readBody(req);
    const message = body['message'];
    if (typeof message !== 'string') {
      ctx.json(res, 400, { error: 'message is required' });
      return true;
    }
    const classified = classifyFailure({
      message,
      context: (body['context'] as never) ?? {},
    });
    const recommendation = selectStrategy(classified.type, Number(body['attempt'] ?? 0));
    ctx.json(res, 200, { classified, recommendation });
    return true;
  }

  return false;
}
