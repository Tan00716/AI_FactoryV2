/**
 * Plan mode routes (W-B) — the plan/execute split.
 *
 *   POST /api/plans                 create a plan (PENDING) + §23.3 approval ticket
 *   GET  /api/plans?status=&taskId=  list plans
 *   GET  /api/plans/:id             fetch one plan
 *   POST /api/plans/:id/approve     approve via the approval ticket → plan APPROVED
 *   POST /api/plans/:id/reject      reject via the approval ticket → plan REJECTED
 *   POST /api/plans/:id/execute     APPROVED → EXECUTING (agent picked it up)
 *   POST /api/plans/:id/finish      EXECUTING → DONE | CANCELLED
 *
 * The decision is DELEGATED to the §23.3 approval machinery: creating a
 * plan requests an approval (action `plan.execute`, candidate_digest =
 * sha256 of the canonical plan content), and approve/reject call
 * ApprovalManager.decide() on that ticket. Digests, required_approvers,
 * deadlines, expiry and the audit trail behave exactly like every other
 * approval; the plan store mirrors the outcome onto the plan.
 *
 * The coordinator wires this in: handlePlanModeRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApprovalManager,
  ApprovalDeciderNotAuthorizedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  type Approval,
} from '@ai-factory/approvals';
import type { RouteContext } from './context';
import { PlanStore, PlanStoreError, planContentDigest, type Plan, type PlanStatus } from '../plan-store';
import { evaluateHooks } from '../hooks';

const PREFIX = '/api/plans';
const PLAN_STATUSES: PlanStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'CANCELLED'];

function store(): PlanStore {
  return new PlanStore();
}

function manager(ctx: RouteContext): ApprovalManager {
  return new ApprovalManager(ctx.fdb.approvals, {
    audit: (action, entityId, details) =>
      ctx.audit.record('plan-mode', action, 'approval', entityId, details),
  });
}

function errStatus(e: unknown): number | null {
  if (e instanceof PlanStoreError) {
    const msg = (e as Error).message;
    if (/not found/.test(msg)) return 404;
    if (/is .*;|not PENDING/.test(msg)) return 409;
    return 400;
  }
  if (e instanceof ApprovalNotFoundError) return 404;
  if (e instanceof ApprovalDeciderNotAuthorizedError) return 403;
  if (e instanceof ApprovalNotPendingError || e instanceof ApprovalExpiredError) return 409;
  return null;
}

function strField(body: Record<string, unknown>, k: string): string | undefined {
  const v = body[k];
  return typeof v === 'string' && v ? v : undefined;
}

function withApproval(ctx: RouteContext, plan: Plan): Record<string, unknown> {
  let approval: Approval | null = null;
  if (plan.approvalId) {
    try {
      approval = manager(ctx).get(plan.approvalId);
    } catch {
      approval = null;
    }
  }
  return { plan, approval };
}

export async function handlePlanModeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/plans — create plan + approval ticket.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const title = strField(body, 'title');
    const stepsRaw = body['steps'];
    if (!title) {
      ctx.json(res, 400, { error: 'title is required' });
      return true;
    }
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      ctx.json(res, 400, { error: 'steps must be a non-empty array' });
      return true;
    }
    const steps = stepsRaw.map((s) => {
      const o = s as Record<string, unknown>;
      return {
        title: typeof o['title'] === 'string' ? o['title'] : '',
        detail: typeof o['detail'] === 'string' ? o['detail'] : undefined,
      };
    });
    const goal = strField(body, 'goal') ?? '';
    const createdBy = strField(body, 'createdBy') ?? strField(body, 'requester') ?? 'human';
    // §23.3 approvals are task-bound by schema (task_id NOT NULL REFERENCES
    // tasks(id)): a plan approves work ON a task, so taskId is required.
    const taskId = strField(body, 'taskId') ?? strField(body, 'task_id');
    if (!taskId) {
      ctx.json(res, 400, { error: 'taskId is required (plans approve work on a task)' });
      return true;
    }
    try {
      ctx.tasks.get(taskId);
    } catch {
      ctx.json(res, 404, { error: `task not found: ${taskId}` });
      return true;
    }
    try {
      const st = store();
      const plan = st.create({
        title,
        goal,
        steps,
        taskId,
        agentId: strField(body, 'agentId') ?? strField(body, 'agent_id') ?? null,
        createdBy,
      });
      // §23.3 ticket bound to the exact plan content.
      const approval = manager(ctx).request({
        action: 'plan.execute',
        requester: createdBy,
        task_id: taskId,
        candidate_digest: planContentDigest({ title: plan.title, goal: plan.goal, steps: plan.steps }),
        risk_level: 'MEDIUM',
        required_approvers: ['human'],
        reversibility_ref: `plan:${plan.id}`,
      });
      const bound = st.bindApproval(plan.id, approval.approval_id);
      ctx.audit.record(createdBy, 'PLAN_CREATED', 'plan', plan.id, {
        steps: plan.steps.length,
        approval_id: approval.approval_id,
      });
      ctx.json(res, 201, { plan: bound, approval });
      return true;
    } catch (e) {
      const status = errStatus(e) ?? 500;
      ctx.json(res, status, { error: (e as Error).message });
      return true;
    }
  }

  // GET /api/plans — list.
  if (method === 'GET' && path === PREFIX) {
    const status = url.searchParams.get('status');
    const taskId = url.searchParams.get('taskId') ?? url.searchParams.get('task_id') ?? undefined;
    if (status !== null && !(PLAN_STATUSES as string[]).includes(status)) {
      ctx.json(res, 400, { error: `status must be one of ${PLAN_STATUSES.join('|')}` });
      return true;
    }
    const plans = store().list({
      status: (status as PlanStatus | null) ?? undefined,
      taskId: taskId ?? undefined,
    });
    ctx.json(res, 200, { plans });
    return true;
  }

  const idMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)(?:/(approve|reject|execute|finish))?$`));
  if (!idMatch) return false;
  const [, id, verb] = idMatch;

  // GET /api/plans/:id
  if (method === 'GET' && !verb) {
    const plan = store().get(id);
    if (!plan) {
      ctx.json(res, 404, { error: `plan not found: ${id}` });
      return true;
    }
    ctx.json(res, 200, withApproval(ctx, plan));
    return true;
  }

  // POST /api/plans/:id/approve | /reject — delegate to the approval ticket.
  if (method === 'POST' && (verb === 'approve' || verb === 'reject')) {
    const body = await ctx.readBody(req);
    const decidedBy = strField(body, 'decidedBy') ?? strField(body, 'decided_by') ?? 'human';
    const reason = strField(body, 'reason') ?? strField(body, 'decision_reason') ?? '';
    if (verb === 'reject' && !reason) {
      ctx.json(res, 400, { error: 'reason is required to reject a plan' });
      return true;
    }
    try {
      const st = store();
      const plan = st.get(id);
      if (!plan) {
        ctx.json(res, 404, { error: `plan not found: ${id}` });
        return true;
      }
      if (!plan.approvalId) {
        ctx.json(res, 409, { error: `plan ${id} has no approval ticket` });
        return true;
      }
      if (plan.status !== 'PENDING') {
        // Fail fast BEFORE touching the ticket: never leave an APPROVED
        // ticket mirrored onto a non-PENDING plan (or vice versa).
        ctx.json(res, 409, { error: `plan ${id} is ${plan.status}, not PENDING` });
        return true;
      }
      const approved = verb === 'approve';
      const approval = manager(ctx).decide(plan.approvalId, {
        approved,
        decided_by: decidedBy,
        decision_reason: reason,
      });
      const updated = st.decide(id, approved, reason);
      ctx.audit.record(decidedBy, approved ? 'PLAN_APPROVED' : 'PLAN_REJECTED', 'plan', id, {
        approval_id: plan.approvalId,
        reason,
      });
      ctx.json(res, 200, { plan: updated, approval });
      return true;
    } catch (e) {
      const status = errStatus(e) ?? 500;
      ctx.json(res, status, { error: (e as Error).message });
      return true;
    }
  }

  // POST /api/plans/:id/execute — APPROVED → EXECUTING.
  if (method === 'POST' && verb === 'execute') {
    try {
      const plan = store().markExecuting(id);
      ctx.audit.record('plan-mode', 'PLAN_EXECUTING', 'plan', id, {});
      ctx.json(res, 200, { plan });
      return true;
    } catch (e) {
      const status = errStatus(e) ?? 500;
      ctx.json(res, status, { error: (e as Error).message });
      return true;
    }
  }

  // POST /api/plans/:id/finish — EXECUTING → DONE | CANCELLED.
  if (method === 'POST' && verb === 'finish') {
    const body = await ctx.readBody(req);
    const done = body['done'] !== false;
    const reason = strField(body, 'reason') ?? '';
    try {
      const plan = store().finish(id, done, reason);
      ctx.audit.record('plan-mode', done ? 'PLAN_DONE' : 'PLAN_CANCELLED', 'plan', id, { reason });
      // Stop hooks: the agent work unit stopped — best-effort, never fatal.
      try {
        await evaluateHooks('Stop', { tool: 'plan', planId: id, done, reason });
      } catch (e) {
        ctx.audit.record('plan-mode', 'HOOK_STOP_FAILED', 'plan', id, {
          reason: (e as Error).message,
        });
      }
      ctx.json(res, 200, { plan });
      return true;
    } catch (e) {
      const status = errStatus(e) ?? 500;
      ctx.json(res, status, { error: (e as Error).message });
      return true;
    }
  }

  return false;
}
