/**
 * Approval routes — SPEC v2 §23.3 (approval object) + §23.4 (levels).
 *
 *   POST /api/approvals                  request a new approval
 *   GET  /api/approvals?status=PENDING    list approvals (sweeps expired first)
 *   GET  /api/approvals/:id              fetch one approval
 *   POST /api/approvals/:id/decision     approve or reject
 *   POST /api/approvals/:id/cancel       withdraw a pending request
 *   POST /api/approvals/:id/invalidate   invalidate on bound-context change
 *   POST /api/approvals/evaluate         policy evaluation (no persistence)
 *
 * The coordinator wires this in: handleApprovalRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApprovalManager,
  ApprovalBlockedError,
  ApprovalDeciderNotAuthorizedError,
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

const APPROVAL_STATUSES: Array<Approval['status']> = [
  'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'INVALIDATED',
];

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
    if (e instanceof ApprovalBlockedError) return 400;
    if (e instanceof ApprovalDeciderNotAuthorizedError) return 403;
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
    const riskLevel = body['risk_level'] ?? body['riskLevel'];
    if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
      return ctx.json(res, 400, { error: 'risk_level must be LOW|MEDIUM|HIGH|CRITICAL' }), true;
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
    const riskLevel = body['risk_level'] ?? body['riskLevel'];
    if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
      return ctx.json(res, 400, { error: 'risk_level must be LOW|MEDIUM|HIGH|CRITICAL' }), true;
    }
    const ttlMs = body['ttlMs'];
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || ttlMs <= 0)) {
      return ctx.json(res, 400, { error: 'ttlMs must be a positive number' }), true;
    }
    const strField = (k: string): string | undefined =>
      typeof body[k] === 'string' && body[k] ? (body[k] as string) : undefined;
    const requiredApprovers = Array.isArray(body['required_approvers'])
      ? (body['required_approvers'] as unknown[]).filter((e): e is string => typeof e === 'string')
      : typeof body['requiredApprover'] === 'string'
        ? [body['requiredApprover'] as string]
        : undefined;
    try {
      const approval = manager.request({
        action,
        requester: strField('requester') ?? strField('requestedBy') ?? 'human',
        task_id: strField('task_id') ?? strField('taskId'),
        requirement_version: strField('requirement_version'),
        candidate_digest: strField('candidate_digest'),
        environment: strField('environment'),
        risk_level: (riskLevel as RiskLevel) ?? undefined,
        reversibility_ref: strField('reversibility_ref'),
        evidence_manifest_hash: strField('evidence_manifest_hash'),
        policy_version: strField('policy_version'),
        required_approvers: requiredApprovers,
        ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined,
      });
      // Notification trigger (module 30): new approval request → MEDIUM.
      ctx.notify.emit({
        type: 'APPROVAL_PENDING',
        actor: approval.requester,
        entity: { kind: 'approval', id: approval.approval_id, label: action },
        detail: { risk_level: approval.risk_level, task_id: approval.task_id },
      });
      return ctx.json(res, 201, approval), true;
    } catch (e) {
      const st = errStatus(e);
      const msg = (e as Error).message;
      const friendly = msg.includes('FOREIGN KEY')
        ? 'task_id must reference an existing task'
        : msg;
      return ctx.json(res, st ?? 400, { error: friendly, name: (e as Error).name }), true;
    }
  }

  // GET /api/approvals?status=
  if (method === 'GET' && path === PREFIX) {
    manager.sweepExpired();
    const status = url.searchParams.get('status');
    if (status !== null && !(APPROVAL_STATUSES as string[]).includes(status)) {
      return ctx.json(res, 400, { error: `status must be ${APPROVAL_STATUSES.join('|')}` }), true;
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
      typeof body['decided_by'] === 'string' && body['decided_by']
        ? (body['decided_by'] as string)
        : typeof body['decidedBy'] === 'string' && body['decidedBy']
          ? (body['decidedBy'] as string)
          : 'human';
    const decisionReason =
      typeof body['decision_reason'] === 'string' ? (body['decision_reason'] as string) : undefined;
    try {
      const approval = manager.decide(id, {
        approved: body['approved'] as boolean,
        decided_by: decidedBy,
        decision_reason: decisionReason,
      });
      // §91 — approval decisions are gate verdicts on the bus.
      ctx.bus.emit(
        approval.status === 'APPROVED' ? 'GATE_PASSED' : 'GATE_FAILED',
        {
          approvalId: approval.approval_id,
          action: approval.action,
          decision: approval.status,
          decidedBy,
          taskId: approval.task_id || undefined,
        },
        'approvals',
      );
      // §41: an approved, task-bound approval satisfies the PENDING_PROD →
      // PROD_DEPLOYING gate once attached as 'approval' evidence.
      if (approval.status === 'APPROVED' && approval.task_id) {
        const ev = ctx.evidence.create({
          taskId: approval.task_id,
          type: 'approval',
          title: `Approval: ${approval.action}`,
          payload: { ...manager.approvalEvidencePayload(approval) },
          createdBy: decidedBy,
        });
        ctx.audit.record(decidedBy, 'APPROVAL_EVIDENCE_ATTACHED', 'evidence', ev.id, {
          approvalId: approval.approval_id,
          taskId: approval.task_id,
          action: approval.action,
        });
      }
      return ctx.json(res, 200, { approval }), true;
    } catch (e) {
      const st = errStatus(e);
      return ctx.json(res, st ?? 500, { error: (e as Error).message, name: (e as Error).name }), true;
    }
  }

  // POST /api/approvals/:id/invalidate — §23.3 bound-context invalidation.
  // Body: { candidate_digest?, evidence_manifest_hash?, policy_version?, environment? }
  // Fields omitted from the body keep the approval's recorded values.
  if (method === 'POST' && id && sub === 'invalidate') {
    const body = await ctx.readBody(req);
    try {
      const current = manager.get(id);
      const strOrCurrent = (k: 'candidate_digest' | 'evidence_manifest_hash' | 'policy_version' | 'environment'): string =>
        typeof body[k] === 'string' ? (body[k] as string) : current[k];
      const result = manager.invalidate(id, {
        candidate_digest: strOrCurrent('candidate_digest'),
        evidence_manifest_hash: strOrCurrent('evidence_manifest_hash'),
        policy_version: strOrCurrent('policy_version'),
        environment: strOrCurrent('environment'),
      });
      return ctx.json(res, 200, { approval: manager.get(id), ...result }), true;
    } catch (e) {
      const st = errStatus(e);
      return ctx.json(res, st ?? 500, { error: (e as Error).message }), true;
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
      const st = errStatus(e);
      return ctx.json(res, st ?? 500, { error: (e as Error).message, name: (e as Error).name }), true;
    }
  }

  return false;
}
