/**
 * Approval routes — spec §45 (Tool Approval) + §69 (Approval System).
 *
 *   POST /api/approvals                  request a new approval
 *   GET  /api/approvals?status=PENDING    list approvals (sweeps expired first)
 *   GET  /api/approvals/:id              fetch one approval
 *   POST /api/approvals/:id/decision     approve or reject
 *   POST /api/approvals/:id/cancel       withdraw a pending request
 *   POST /api/approvals/evaluate         policy evaluation (no persistence)
 *
 * The coordinator wires this in: handleApprovalRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApprovalManager,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalExpiredError,
  evaluateAction,
  type Approval,
  type RiskLevel,
} from '@ai-factory/approvals';
import type { RouteContext } from './context';

const PREFIX = '/api/approvals';

function isRiskLevel(v: unknown): v is RiskLevel {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL';
}

export async function handleApprovalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const manager = new ApprovalManager(ctx.fdb.approvals, {
    audit: (action, entityId, details) =>
      ctx.audit.record('approval-service', action, 'approval', entityId, details),
  });

  const errStatus = (e: unknown): number | null => {
    if (e instanceof ApprovalNotFoundError) return 404;
    if (e instanceof ApprovalNotPendingError || e instanceof ApprovalExpiredError) return 409;
    return null;
  };

  // POST /api/approvals/evaluate — must come before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/evaluate`) {
    const body = await ctx.readBody(req);
    const action = body['action'];
    if (typeof action !== 'string' || !action) {
      return ctx.json(res, 400, { error: 'action is required' }), true;
    }
    const riskLevel = body['riskLevel'];
    if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
      return ctx.json(res, 400, { error: 'riskLevel must be LOW|MEDIUM|HIGH|CRITICAL' }), true;
    }
    return ctx.json(res, 200, evaluateAction(action, (riskLevel as RiskLevel) ?? 'LOW')), true;
  }

  // POST /api/approvals
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const action = body['action'];
    if (typeof action !== 'string' || !action) {
      return ctx.json(res, 400, { error: 'action is required' }), true;
    }
    const riskLevel = body['riskLevel'];
    if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
      return ctx.json(res, 400, { error: 'riskLevel must be LOW|MEDIUM|HIGH|CRITICAL' }), true;
    }
    const ttlMs = body['ttlMs'];
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || ttlMs <= 0)) {
      return ctx.json(res, 400, { error: 'ttlMs must be a positive number' }), true;
    }
    try {
      const approval = manager.request({
        action,
        requestedBy: typeof body['requestedBy'] === 'string' && body['requestedBy'] ? (body['requestedBy'] as string) : 'human',
        agentId: typeof body['agentId'] === 'string' ? (body['agentId'] as string) : undefined,
        taskId: typeof body['taskId'] === 'string' ? (body['taskId'] as string) : undefined,
        riskLevel: (riskLevel as RiskLevel) ?? undefined,
        evidenceIds: Array.isArray(body['evidenceIds'])
          ? (body['evidenceIds'] as unknown[]).filter((e): e is string => typeof e === 'string')
          : undefined,
        requiredApprover: typeof body['requiredApprover'] === 'string' ? (body['requiredApprover'] as string) : undefined,
        ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined,
      });
      // Notification trigger (module 30): new approval request → MEDIUM.
      ctx.notify.emit({
        type: 'APPROVAL_PENDING',
        actor: typeof body['requestedBy'] === 'string' && body['requestedBy'] ? (body['requestedBy'] as string) : 'human',
        entity: { kind: 'approval', id: approval.id, label: action },
        detail: { riskLevel: approval.riskLevel, taskId: approval.taskId },
      });
      return ctx.json(res, 201, approval), true;
    } catch (e) {
      const msg = (e as Error).message;
      const friendly = msg.includes('FOREIGN KEY')
        ? 'taskId must reference an existing task'
        : msg;
      return ctx.json(res, 400, { error: friendly }), true;
    }
  }

  // GET /api/approvals?status=
  if (method === 'GET' && path === PREFIX) {
    manager.sweepExpired();
    const status = url.searchParams.get('status');
    if (status !== null && !['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(status)) {
      return ctx.json(res, 400, { error: 'status must be PENDING|APPROVED|REJECTED|EXPIRED|CANCELLED' }), true;
    }
    return ctx.json(res, 200, manager.list((status ?? undefined) as Approval['status'] | undefined)), true;
  }

  const rest = path.slice(PREFIX.length + 1); // after '/api/approvals/'
  const [id, sub] = rest.split('/');

  // GET /api/approvals/:id
  if (method === 'GET' && id && !sub) {
    try {
      return ctx.json(res, 200, manager.get(id)), true;
    } catch (e) {
      const s = errStatus(e);
      return ctx.json(res, s ?? 500, { error: (e as Error).message }), true;
    }
  }

  // POST /api/approvals/:id/decision
  if (method === 'POST' && id && sub === 'decision') {
    const body = await ctx.readBody(req);
    if (typeof body['approved'] !== 'boolean') {
      return ctx.json(res, 400, { error: 'approved (boolean) is required' }), true;
    }
    const decidedBy =
      typeof body['decidedBy'] === 'string' && body['decidedBy'] ? (body['decidedBy'] as string) : 'human';
    try {
      const approval = manager.decide(id, {
        approved: body['approved'] as boolean,
        decidedBy,
      });
      // §91 — approval decisions are gate verdicts on the bus.
      ctx.bus.emit(
        approval.status === 'APPROVED' ? 'GATE_PASSED' : 'GATE_FAILED',
        {
          approvalId: approval.id,
          action: approval.action,
          decision: approval.status,
          decidedBy,
          taskId: approval.taskId ?? undefined,
        },
        'approvals',
      );
      // §41: an approved, task-bound approval satisfies the PENDING_PROD →
      // PROD_DEPLOYING gate once attached as 'approval' evidence.
      if (approval.status === 'APPROVED' && approval.taskId) {
        const ev = ctx.evidence.create({
          taskId: approval.taskId,
          type: 'approval',
          title: `Approval: ${approval.action}`,
          payload: { ...manager.approvalEvidencePayload(approval) },
          createdBy: decidedBy,
        });
        ctx.audit.record(decidedBy, 'APPROVAL_EVIDENCE_ATTACHED', 'evidence', ev.id, {
          approvalId: approval.id,
          taskId: approval.taskId,
          action: approval.action,
        });
      }
      return ctx.json(res, 200, { approval }), true;
    } catch (e) {
      const s = errStatus(e);
      return ctx.json(res, s ?? 500, { error: (e as Error).message }), true;
    }
  }

  // POST /api/approvals/:id/cancel
  if (method === 'POST' && id && sub === 'cancel') {
    const body = await ctx.readBody(req);
    const by = typeof body['by'] === 'string' && body['by'] ? (body['by'] as string) : 'human';
    try {
      const approval = manager.cancel(id, by);
      return ctx.json(res, 200, { approval }), true;
    } catch (e) {
      const s = errStatus(e);
      return ctx.json(res, s ?? 500, { error: (e as Error).message }), true;
    }
  }

  return false;
}
