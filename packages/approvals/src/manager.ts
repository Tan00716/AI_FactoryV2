/**
 * ApprovalManager — SPEC v2 §23.3 approval lifecycle.
 *
 * request → PENDING → decide → APPROVED | REJECTED
 *                    ↘ cancel → CANCELLED
 *                    ↘ (deadline passes) → EXPIRED  (via decide() or sweepExpired())
 * APPROVED ↘ invalidate → INVALIDATED  (bound context changed; history kept)
 *
 * DEF-001 hardening (v2):
 *  - request() evaluates the action against policy first: BLOCKED actions
 *    are refused outright ("BLOCKED actions cannot be approved") — no ticket
 *    is ever created for them.
 *  - decide() verifies the decider satisfies required_approvers: a rogue
 *    agent cannot self-approve a ticket that requires a human.
 *  - An APPROVED approval is bound to candidate_digest / evidence_manifest_hash /
 *    policy_version / environment. invalidate() marks it INVALIDATED (append,
 *    never rewriting history) when any of those change; callers must
 *    re-request. checkBinding() lets gates verify freshness before use.
 */

import { createHash, randomUUID } from 'node:crypto';
import { nowIso } from '@ai-factory/core';
import {
  Approval,
  ApprovalStatus,
  InMemoryApprovalStore,
  RiskLevel,
  ApprovalStore,
} from './types';
import { evaluateAction } from './policy';

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval ${id} not found`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(id: string, status: ApprovalStatus) {
    super(`Approval ${id} is ${status}, not PENDING — cannot decide/cancel`);
    this.name = 'ApprovalNotPendingError';
  }
}

export class ApprovalExpiredError extends Error {
  constructor(id: string, deadline: string) {
    super(`Approval ${id} expired at ${deadline}`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalNotApprovedError extends Error {
  constructor(id: string, status: ApprovalStatus) {
    super(`Approval ${id} is ${status}, not APPROVED — no evidence payload`);
    this.name = 'ApprovalNotApprovedError';
  }
}

/**
 * DEF-001 fix (1/2): thrown by request() when policy evaluates the action
 * to BLOCKED. The ticket is never created.
 */
export class ApprovalBlockedError extends Error {
  constructor(action: string, reason: string) {
    super(`BLOCKED actions cannot be approved: '${action}' — ${reason}`);
    this.name = 'ApprovalBlockedError';
  }
}

/**
 * DEF-001 fix (2/2): thrown by decide() when the decider identity does not
 * satisfy required_approvers (e.g. a ticket requiring 'human' decided by
 * 'rogue-agent').
 */
export class ApprovalDeciderNotAuthorizedError extends Error {
  constructor(id: string, decidedBy: string, required: string[]) {
    super(
      `Approval ${id}: decider '${decidedBy}' does not satisfy required_approvers [${required.join(', ')}]`,
    );
    this.name = 'ApprovalDeciderNotAuthorizedError';
  }
}

/** Audit hook: (action, entityId, details). The caller wires it to ctx.audit.record. */
export type ApprovalAuditFn = (
  action: string,
  entityId: string,
  details: Record<string, unknown>,
) => void;

export interface ApprovalManagerOptions {
  audit?: ApprovalAuditFn;
  /** Default time-to-live for a request. Defaults to 24h. */
  defaultTtlMs?: number;
  /** Policy version stamped onto new tickets. Defaults to 'v1'. */
  policyVersion?: string;
}

export interface RequestApprovalInput {
  action: string;
  requester: string;
  task_id?: string;
  requirement_version?: string;
  candidate_digest?: string;
  environment?: string;
  risk_level?: RiskLevel;
  reversibility_ref?: string;
  evidence_manifest_hash?: string;
  policy_version?: string;
  required_approvers?: string[];
  /** Explicit ISO deadline; overrides ttlMs. Null = never expires. */
  deadline?: string | null;
  /** Overrides the manager default for this request. */
  ttlMs?: number;
}

export interface DecideApprovalInput {
  approved: boolean;
  decided_by: string;
  decision_reason?: string;
}

/** The bound context an APPROVED approval is tied to (§23.3). */
export interface ApprovalBindingContext {
  candidate_digest: string;
  evidence_manifest_hash: string;
  policy_version: string;
  environment: string;
}

export interface InvalidationResult {
  invalidated: boolean;
  changed: Array<keyof ApprovalBindingContext>;
}

/** Machine-readable payload attached to a task as 'approval' evidence. */
export interface ApprovalEvidencePayload {
  verdict: 'APPROVED';
  approval_id: string;
  action: string;
  action_digest: string;
  decided_by: string;
  candidate_digest: string;
  evidence_manifest_hash: string;
  policy_version: string;
  environment: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Canonical digest of the action being approved (§23.3 action_digest). */
export function actionDigest(action: string): string {
  return createHash('sha256').update(`approval-action:${action}`).digest('hex');
}

/**
 * Does a decider identity satisfy the required_approvers list? An entry is
 * either an exact identity ('human:alice') or a role prefix ('human', which
 * matches 'human' and 'human:alice').
 */
export function deciderSatisfies(required: string[], decidedBy: string): boolean {
  return required.some(
    (r) => decidedBy === r || decidedBy.startsWith(`${r}:`),
  );
}

export class ApprovalManager {
  private readonly audit?: ApprovalAuditFn;
  private readonly defaultTtlMs: number;
  private readonly defaultPolicyVersion: string;

  constructor(
    private readonly store: ApprovalStore = new InMemoryApprovalStore(),
    opts: ApprovalManagerOptions = {},
  ) {
    this.audit = opts.audit;
    this.defaultTtlMs = opts.defaultTtlMs ?? DAY_MS;
    this.defaultPolicyVersion = opts.policyVersion ?? 'v1';
  }

  private emit(
    action: string,
    approval: Approval,
    details: Record<string, unknown> = {},
  ): void {
    this.audit?.(action, approval.approval_id, {
      action: approval.action,
      ...details,
    });
  }

  /**
   * Create a new PENDING approval request.
   * DEF-001: BLOCKED actions are refused here — the ticket is never created.
   */
  request(input: RequestApprovalInput): Approval {
    if (!input.action) throw new Error('action is required');
    if (!input.requester) throw new Error('requester is required');
    const riskLevel = input.risk_level ?? 'MEDIUM';
    const evaluation = evaluateAction(input.action, riskLevel);
    if (evaluation.level === 'BLOCKED') {
      throw new ApprovalBlockedError(input.action, evaluation.reason);
    }
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    const approval: Approval = {
      approval_id: randomUUID(),
      action_digest: actionDigest(input.action),
      action: input.action,
      task_id: input.task_id ?? '',
      requirement_version: input.requirement_version ?? '',
      candidate_digest: input.candidate_digest ?? '',
      environment: input.environment ?? '',
      risk_level: riskLevel,
      reversibility_ref: input.reversibility_ref ?? '',
      evidence_manifest_hash: input.evidence_manifest_hash ?? '',
      policy_version: input.policy_version ?? this.defaultPolicyVersion,
      requester: input.requester,
      required_approvers: [...(input.required_approvers ?? ['human'])],
      status: 'PENDING',
      decision: '',
      decision_reason: '',
      decided_by: '',
      created_at: nowIso(),
      decided_at: null,
      deadline:
        input.deadline === undefined
          ? new Date(Date.now() + ttl).toISOString()
          : input.deadline,
    };
    this.store.save(approval);
    this.emit('APPROVAL_REQUESTED', approval, {
      task_id: approval.task_id,
      risk_level: approval.risk_level,
      required_approvers: approval.required_approvers,
      requester: approval.requester,
      policy_evaluation: evaluation.level,
    });
    return approval;
  }

  get(id: string): Approval {
    const a = this.store.get(id);
    if (!a) throw new ApprovalNotFoundError(id);
    return a;
  }

  list(status?: ApprovalStatus): Approval[] {
    return this.store.list(status);
  }

  listByTask(taskId: string): Approval[] {
    return this.store.listByTask(taskId);
  }

  private isExpired(a: Approval): boolean {
    return a.deadline !== null && Date.now() >= new Date(a.deadline).getTime();
  }

  private markExpired(a: Approval): Approval {
    const expired: Approval = { ...a, status: 'EXPIRED', decided_at: nowIso() };
    this.store.save(expired);
    this.emit('APPROVAL_EXPIRED', expired, { deadline: expired.deadline });
    return expired;
  }

  /**
   * Decide a pending approval. Throws ApprovalNotFoundError,
   * ApprovalNotPendingError, ApprovalExpiredError (the approval is
   * auto-marked EXPIRED first, with an audit record), or
   * ApprovalDeciderNotAuthorizedError (DEF-001: the decider does not satisfy
   * required_approvers).
   */
  decide(id: string, input: DecideApprovalInput): Approval {
    const a = this.get(id);
    if (a.status !== 'PENDING') throw new ApprovalNotPendingError(id, a.status);
    if (this.isExpired(a)) {
      const expired = this.markExpired(a);
      throw new ApprovalExpiredError(id, expired.deadline ?? 'unknown');
    }
    if (!input.decided_by) throw new Error('decided_by is required');
    if (!deciderSatisfies(a.required_approvers, input.decided_by)) {
      throw new ApprovalDeciderNotAuthorizedError(id, input.decided_by, a.required_approvers);
    }
    const decided: Approval = {
      ...a,
      status: input.approved ? 'APPROVED' : 'REJECTED',
      decision: input.approved ? 'APPROVED' : 'REJECTED',
      decision_reason: input.decision_reason ?? '',
      decided_by: input.decided_by,
      decided_at: nowIso(),
    };
    this.store.save(decided);
    this.emit('APPROVAL_DECIDED', decided, {
      approved: input.approved,
      decided_by: input.decided_by,
    });
    return decided;
  }

  /** Withdraw a pending request. Throws if the approval is not PENDING. */
  cancel(id: string, by: string): Approval {
    const a = this.get(id);
    if (a.status !== 'PENDING') throw new ApprovalNotPendingError(id, a.status);
    const cancelled: Approval = {
      ...a,
      status: 'CANCELLED',
      decided_at: nowIso(),
      decided_by: by,
      decision_reason: 'withdrawn by requester',
    };
    this.store.save(cancelled);
    this.emit('APPROVAL_CANCELLED', cancelled, { cancelled_by: by });
    return cancelled;
  }

  /**
   * Mark every overdue PENDING approval as EXPIRED (with an audit record
   * each). Returns the approvals that were expired.
   */
  sweepExpired(): Approval[] {
    const expired: Approval[] = [];
    for (const a of this.store.list('PENDING')) {
      if (this.isExpired(a)) expired.push(this.markExpired(a));
    }
    return expired;
  }

  /**
   * §23.3 invalidation: compare the bound context of an APPROVED approval
   * against the current context. If candidate_digest, evidence_manifest_hash,
   * policy_version or environment changed, the approval is marked INVALIDATED
   * (appended as a new state with an audit record — history is never
   * rewritten) and must be re-requested.
   */
  invalidate(id: string, current: ApprovalBindingContext): InvalidationResult {
    const a = this.get(id);
    const changed = (Object.keys(current) as Array<keyof ApprovalBindingContext>).filter(
      (k) => a[k] !== current[k],
    );
    if (a.status !== 'APPROVED' || changed.length === 0) {
      return { invalidated: false, changed };
    }
    const invalidated: Approval = {
      ...a,
      status: 'INVALIDATED',
      decision_reason: `bound context changed: ${changed.join(', ')}`,
    };
    this.store.save(invalidated);
    this.emit('APPROVAL_INVALIDATED', invalidated, { changed });
    return { invalidated: true, changed };
  }

  /**
   * Check whether an approval is still usable: APPROVED and bound context
   * unchanged. Convenience for gates — call invalidate() first when the
   * context may have moved.
   */
  isUsable(a: Approval, current?: ApprovalBindingContext): boolean {
    if (a.status !== 'APPROVED') return false;
    if (!current) return true;
    return (Object.keys(current) as Array<keyof ApprovalBindingContext>).every(
      (k) => a[k] === current[k],
    );
  }

  /**
   * Build the 'approval' evidence payload for an APPROVED approval.
   * Throws for anything else (including INVALIDATED — a stale approval can
   * never satisfy a gate).
   */
  approvalEvidencePayload(approval: Approval): ApprovalEvidencePayload {
    if (approval.status !== 'APPROVED') {
      throw new ApprovalNotApprovedError(approval.approval_id, approval.status);
    }
    return {
      verdict: 'APPROVED',
      approval_id: approval.approval_id,
      action: approval.action,
      action_digest: approval.action_digest,
      decided_by: approval.decided_by,
      candidate_digest: approval.candidate_digest,
      evidence_manifest_hash: approval.evidence_manifest_hash,
      policy_version: approval.policy_version,
      environment: approval.environment,
    };
  }
}
