/**
 * Takeover routes — SPEC_V2 §31 (lives in @ai-factory/takeover).
 *
 *  POST /api/takeovers                              {runId, resourceId, requestedBy}
 *  GET  /api/takeovers/:id                          record + UI display state
 *  POST /api/takeovers/:id/acquire                  quiesce → fence → verify → snapshot
 *  POST /api/takeovers/:id/edits                    record a human edit
 *  POST /api/takeovers/:id/return                   {overlappingFiles, affectedEvidenceIds}
 *  POST /api/takeovers/:id/cancel                   {reason}
 *
 * NOTE: not wired into index.ts (Wave-3 constraint) — export the installer
 * for the coordinator to mount. The hooks below are safe defaults; the
 * coordinator should inject the real control-plane implementations.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { LeaseManager } from '@ai-factory/leases';
import { TakeoverManager } from '@ai-factory/takeover';
import type { RouteContext } from './context';

const leases = new LeaseManager();
const manager = new TakeoverManager(leases, {
  quiesceWorker: async () => {},
  noUncontrolledWrites: async () => true,
  snapshot: async (runId, resourceId) => `snap:${runId}:${resourceId}`,
  threeWayMerge: async (files) => files,
  revalidateEvidence: async (ids) => ids,
});

export async function handleTakeoverRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/takeovers')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/takeovers'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 0) {
    const body = await ctx.readBody(req);
    try {
      const t = manager.requestTakeover(
        body['runId'] as string,
        body['resourceId'] as string,
        (body['requestedBy'] as string) ?? 'api',
      );
      ctx.audit.record('api', 'TAKEOVER_REQUESTED', 'takeover', t.id, {});
      ctx.json(res, 201, { takeover: t, display: manager.display(t.id) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1) {
    try {
      const t = manager.get(seg[0]);
      ctx.json(res, 200, { takeover: t, display: manager.display(seg[0]) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[1] === 'acquire') {
    try {
      const t = await manager.acquireControl(seg[0]);
      ctx.audit.record('api', 'TAKEOVER_ACQUIRED', 'takeover', seg[0], { state: t.state });
      ctx.json(res, 200, { takeover: t, display: manager.display(seg[0]) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[1] === 'edits') {
    const body = await ctx.readBody(req);
    try {
      const t = manager.applyHumanEdit(seg[0], {
        authorId: body['authorId'] as string,
        baseRevision: body['baseRevision'] as string,
        fileHashes: (body['fileHashes'] as Record<string, string>) ?? {},
        diff: (body['diff'] as string) ?? '',
      });
      ctx.json(res, 200, { takeover: t });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[1] === 'return') {
    const body = await ctx.readBody(req);
    try {
      const t = await manager.returnControl(seg[0], {
        overlappingFiles: (body['overlappingFiles'] as string[]) ?? [],
        affectedEvidenceIds: (body['affectedEvidenceIds'] as string[]) ?? [],
      });
      ctx.audit.record('api', 'TAKEOVER_RETURNED', 'takeover', seg[0], {});
      ctx.json(res, 200, { takeover: t, display: manager.display(seg[0]) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[1] === 'cancel') {
    const body = await ctx.readBody(req);
    try {
      const t = manager.cancel(seg[0], (body['reason'] as string) ?? '');
      ctx.json(res, 200, { takeover: t });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}
