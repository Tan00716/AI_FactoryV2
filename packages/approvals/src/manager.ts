/**
 * ApprovalManager — spec §69 approval lifecycle.
 *
 * request → PENDING → decide → APPROVED | REJECTED
 *                    ↘ cancel → CANCELLED
 *                    ↘ (ttl passes) → EXPIRED  (via decide() or sweepExpired())
 *
 * Approved approvals can be attached to a task as 'approval' evidence via
 * approvalEvidencePayload(), which is exactly what the PENDING_PROD →
 * PROD_DEPLOYING gate (§41) looks for.
 */

import { randomUUID } from 'node:crypto';
import { nowIso } from '@ai-factory/core';
import {
  Approval,
  ApprovalStatus,
  InMemoryApprovalStore,
  RiskLevel,
  ApprovalStore,
} from './types';

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
  constructor(id: string, expiresAt: string) {
    super(`Approval ${id} expired at ${expiresAt}`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalNotApprovedError extends Error {
  constructor(id: string, status: ApprovalStatus) {
    super(`Approval ${id} is ${status}, not APPROVED — no evidence payload`);
    this.name = 'ApprovalNotApprovedError';
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
}

export interface RequestApprovalInput {
  action: string;
  requestedBy: string;
  agentId?: string;
  taskId?: string;
  riskLevel?: RiskLevel;
  evidenceIds?: string[];
  requiredApprover?: string;
  /** Overrides the manager default for this request. */
  ttlMs?: number;
}

export interface DecideApprovalInput {
  approved: boolean;
  decidedBy: string;
}

/** Machine-readable payload attached to a task as 'approval' evidence (§37). */
export interface ApprovalEvidencePayload {
  verdict: 'APPROVED';
  approvalId: string;
  action: string;
  decidedBy: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ApprovalManager {
  private readonly audit?: ApprovalAuditFn;
  private readonly defaultTtlMs: number;

  constructor(
    private readonly store: ApprovalStore = new InMemoryApprovalStore(),
    opts: ApprovalManagerOptions = {},
  ) {
    this.audit = opts.audit;
    this.defaultTtlMs = opts.defaultTtlMs ?? DAY_MS;
  }

  private emit(
    action: string,
    approval: Approval,
    details: Record<string, unknown> = {},
  ): void {
    this.audit?.(action, approval.id, { action: approval.action, ...details });
  }

  /** Create a new PENDING approval request. */
  request(input: RequestApprovalInput): Approval {
    if (!input.action) throw new Error('action is required');
    if (!input.requestedBy) throw new Error('requestedBy is required');
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    const approval: Approval = {
      id: randomUUID(),
      action: input.action,
      requestedBy: input.requestedBy,
      agentId: input.agentId ?? '',
      taskId: input.taskId ?? '',
      riskLevel: input.riskLevel ?? 'MEDIUM',
      evidenceIds: [...(input.evidenceIds ?? [])],
      requiredApprover: input.requiredApprover ?? 'human',
      status: 'PENDING',
      decision: '',
      decidedBy: '',
      createdAt: nowIso(),
      decidedAt: null,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
    };
    this.store.save(approval);
    this.emit('APPROVAL_REQUESTED', approval, {
      taskId: approval.taskId,
      riskLevel: approval.riskLevel,
      requiredApprover: approval.requiredApprover,
      requestedBy: approval.requestedBy,
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
    return (
      a.expiresAt !== null && Date.now() >= new Date(a.expiresAt).getTime()
    );
  }

  private markExpired(a: Approval): Approval {
    const expired: Approval = { ...a, status: 'EXPIRED', decidedAt: nowIso() };
    this.store.save(expired);
    this.emit('APPROVAL_EXPIRED', expired, { expiresAt: expired.expiresAt });
    return expired;
  }

  /**
   * Decide a pending approval. Throws ApprovalNotFoundError,
   * ApprovalNotPendingError, or ApprovalExpiredError (the approval is
   * auto-marked EXPIRED first, with an audit record).
   */
  decide(id: string, input: DecideApprovalInput): Approval {
    const a = this.get(id);
    if (a.status !== 'PENDING') throw new ApprovalNotPendingError(id, a.status);
    if (this.isExpired(a)) {
      const expired = this.markExpired(a);
      throw new ApprovalExpiredError(id, expired.expiresAt ?? 'unknown');
    }
    const decided: Approval = {
      ...a,
      status: input.approved ? 'APPROVED' : 'REJECTED',
      decision: input.approved ? 'APPROVED' : 'REJECTED',
      decidedBy: input.decidedBy,
      decidedAt: nowIso(),
    };
    this.store.save(decided);
    this.emit('APPROVAL_DECIDED', decided, {
      approved: input.approved,
      decidedBy: input.decidedBy,
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
      decidedAt: nowIso(),
      decidedBy: by,
    };
    this.store.save(cancelled);
    this.emit('APPROVAL_CANCELLED', cancelled, { cancelledBy: by });
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
   * Build the EvidenceType 'approval' payload for an APPROVED approval.
   * Attach it to the task via EvidenceEngine.create — the PENDING_PROD →
   * PROD_DEPLOYING gate (§41) is satisfied by its presence.
   */
  approvalEvidencePayload(approval: Approval): ApprovalEvidencePayload {
    if (approval.status !== 'APPROVED') {
      throw new ApprovalNotApprovedError(approval.id, approval.status);
    }
    return {
      verdict: 'APPROVED',
      approvalId: approval.id,
      action: approval.action,
      decidedBy: approval.decidedBy,
    };
  }
}
