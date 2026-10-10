/**
 * Quota routes — SPEC_V2 §27 (lives in @ai-factory/quota).
 *
 *  POST /api/quota/buckets                         record a provider bucket
 *  GET  /api/quota/buckets                         list buckets (usage display)
 *  POST /api/quota/limit-signal                    {signal, bucket, retryAfterSec?}
 *  POST /api/quota/decide                          {policy?, event, affectedRunIds}
 *  POST /api/quota/handoffs                        seal a handoff package
 *  POST /api/quota/handoffs/verify                 verify a received package
 *
 * NOTE: not wired into index.ts (Wave-3 constraint) — export the installer
 * for the coordinator to mount.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  createHandoffPackage,
  QuotaMonitor,
  verifyHandoffPackage,
  type LimitEvent,
  type QuotaBucket,
} from '@ai-factory/quota';
import type { RouteContext } from './context';

const monitor = new QuotaMonitor();

export async function handleQuotaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/quota')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/quota'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg[0] === 'buckets' && seg.length === 1) {
    const body = await ctx.readBody(req);
    try {
      monitor.recordBucket(body['bucket'] as QuotaBucket);
      ctx.audit.record('api', 'QUOTA_BUCKET_RECORDED', 'quota', 'bucket', {});
      ctx.json(res, 201, { ok: true });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'limit-signal') {
    const body = await ctx.readBody(req);
    try {
      const event = monitor.recordLimitSignal(
        body['signal'] as string,
        body['bucket'] as QuotaBucket,
        body['retryAfterSec'] as number | undefined,
      );
      ctx.json(res, 201, { event });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'decide') {
    const body = await ctx.readBody(req);
    try {
      if (body['policy']) monitor.setPolicy(body['policy'] as never);
      const decision = monitor.decide(
        body['event'] as LimitEvent,
        (body['affectedRunIds'] as string[]) ?? [],
      );
      ctx.json(res, 200, { decision });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'handoffs' && seg.length === 1) {
    const body = await ctx.readBody(req);
    try {
      const pkg = createHandoffPackage(body['package'] as never);
      ctx.audit.record('api', 'HANDOFF_SEALED', 'handoff', pkg.handoffId, {});
      ctx.json(res, 201, { handoff: pkg });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg[0] === 'handoffs' && seg[1] === 'verify') {
    const body = await ctx.readBody(req);
    try {
      verifyHandoffPackage(body['package'] as never);
      ctx.json(res, 200, { ok: true });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // GET /api/quota/buckets — list buckets (usage display, §29.1 quota strip).
  if (method === 'GET' && seg[0] === 'buckets' && seg.length === 1) {
    ctx.json(res, 200, { buckets: monitor.listBuckets() });
    return true;
  }

  return false;
}
