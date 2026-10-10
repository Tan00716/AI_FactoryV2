/**
 * Disagreement routes — spec §96–§97 (lives in @ai-factory/evaluation).
 *
 *  POST /api/disputes             {verdictA, verdictB} → detect + independent adjudication
 *  GET  /api/disputes?status=     list disputes
 *  POST /api/disputes/verify-gate {task} → whether independent verification applies (§97)
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DisputeCoordinator,
  shouldUseIndependentVerification,
} from '@ai-factory/evaluation';
import type { RouteContext } from './context';

const coordinator = new DisputeCoordinator();

export async function handleDisputeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/disputes')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/disputes'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 0) {
    const body = await ctx.readBody(req);
    const verdictA = body['verdictA'] as never | undefined;
    const verdictB = body['verdictB'] as never | undefined;
    if (!verdictA || !verdictB) {
      ctx.json(res, 400, { error: 'verdictA and verdictB are required' });
      return true;
    }
    const dispute = coordinator.open(verdictA, verdictB);
    if (!dispute) {
      ctx.json(res, 200, { dispute: null, note: 'no conflict between verdicts' });
      return true;
    }
    const outcome = coordinator.adjudicate(dispute.disputeId);
    ctx.audit.record('system', 'DISPUTE_ADJUDICATED', 'dispute', dispute.disputeId, {
      status: outcome.dispute.status,
    });
    ctx.json(res, 200, { dispute: outcome.dispute, outcome });
    return true;
  }

  if (method === 'GET' && seg.length === 0) {
    const status = url.searchParams.get('status') ?? undefined;
    ctx.json(res, 200, { disputes: coordinator.list(status as never) });
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'verify-gate') {
    const body = await ctx.readBody(req);
    const task = body['task'] as never | undefined;
    if (!task) {
      ctx.json(res, 400, { error: 'task is required' });
      return true;
    }
    ctx.json(res, 200, shouldUseIndependentVerification(task));
    return true;
  }

  return false;
}
