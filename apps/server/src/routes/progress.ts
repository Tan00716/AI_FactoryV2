/**
 * Progress routes — SPEC_V2 §20 (lives in @ai-factory/progress).
 *
 *  POST /api/progress/plans                 {items?, } → weight plan (default example when omitted)
 *  GET  /api/progress/plans/:id             get plan
 *  POST /api/progress/compute                {planId, completions[], blockers?} → progress report
 *  POST /api/progress/plans/:id/split        {itemId, parts} → new plan version (weight conserved)
 *  POST /api/progress/invalidate             {planId, itemId, to, reason} → honest decrease
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  CompletionLedger,
  applyInvalidation,
  computeProgress,
  defaultWeightPlan,
  splitItem,
} from '@ai-factory/progress';
import type { WeightPlan } from '@ai-factory/progress';
import type { RouteContext } from './context';

const plans = new Map<string, WeightPlan>();
const ledger = new CompletionLedger();

export async function handleProgressRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/progress')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/progress'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'plans') {
    const body = await ctx.readBody(req);
    const plan: WeightPlan = body['items']
      ? {
          id: `wp-${Date.now()}`,
          version: 1,
          items: body['items'] as never,
          createdAt: new Date().toISOString(),
          supersedes: null,
          scopeChangeNote: null,
          authorizations: [],
        }
      : defaultWeightPlan();
    plans.set(plan.id, plan);
    ctx.json(res, 201, { plan });
    return true;
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'plans') {
    const plan = plans.get(seg[1]);
    if (!plan) {
      ctx.json(res, 404, { error: `weight plan ${seg[1]} not found` });
      return true;
    }
    ctx.json(res, 200, { plan });
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'compute') {
    const body = await ctx.readBody(req);
    const plan = plans.get(body['planId'] as string);
    if (!plan) {
      ctx.json(res, 404, { error: `weight plan ${body['planId']} not found` });
      return true;
    }
    try {
      const report = computeProgress(
        plan,
        (body['completions'] as never[]) ?? [],
        { blockers: body['blockers'] as string[] | undefined },
      );
      ctx.json(res, 200, { report });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'plans' && seg[2] === 'split') {
    const body = await ctx.readBody(req);
    const plan = plans.get(seg[1]);
    if (!plan) {
      ctx.json(res, 404, { error: `weight plan ${seg[1]} not found` });
      return true;
    }
    try {
      const v2 = splitItem(plan, body['itemId'] as string, body['parts'] as never, 'api');
      plans.set(v2.id, v2);
      ctx.json(res, 201, { plan: v2 });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'invalidate') {
    const body = await ctx.readBody(req);
    const plan = plans.get(body['planId'] as string);
    if (!plan) {
      ctx.json(res, 404, { error: `weight plan ${body['planId']} not found` });
      return true;
    }
    // Rebuild completions from the request, apply the invalidation, recompute.
    const completions = new Map(
      ((body['completions'] as never[]) ?? []).map((e) => [(e as { itemId: string }).itemId, e]),
    );
    try {
      applyInvalidation(
        completions as never,
        ledger,
        body['itemId'] as string,
        Number(body['to']),
        (body['reason'] as string | undefined) ?? 'evidence invalidated',
        'api',
      );
      const report = computeProgress(plan, [...completions.values()] as never);
      ctx.json(res, 200, { report, ledger: ledger.list(body['itemId'] as string) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}
