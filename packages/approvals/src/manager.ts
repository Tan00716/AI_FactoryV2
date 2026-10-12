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
 *
 * §23.4 Exception Grants (exceptions.ts): a legitimate Human may waive a
 * waivable rule via a time-limited, scoped, audited grant. evaluateApprovalGate()
 * is the consumption point: a covered failure is reported WAIVED with the
 * original failure reason preserved — never PASS, never an approval.
 * BLOCKED actions are non-waivable invariants: grant creation and gate use
 * are both refused and audited.
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
import {
  ExceptionGrant,
  ExceptionGrantDeniedError,
  ExceptionGrantNotFoundError,
  ExceptionGrantStatus,
  ExceptionGrantStore,
  InMemoryExceptionGrantStore,
  isHumanActor,
} from './exceptions';

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
  /** §23.4 exception-grant store. Defaults to an in-memory store. */
  exceptionGrants?: ExceptionGrantStore;
  /** Default TTL for exception grants. Defaults to 24h. */
  exceptionGrantDefaultTtlMs?: number;
  /**
   * Hard cap on exception-grant TTL. Defaults to 7 days. A grant can never
   * outlive this — permanent waivers do not exist (§23.4).
   */
  exceptionGrantMaxTtlMs?: number;
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
  /**
   * §23.3 risk substance: a material risk-level change after APPROVED
   * invalidates the approval — the old decision must not cover a riskier action.
   */
  risk_level: RiskLevel;
  /** §23.3 reversibility substance: changed reversibility invalidates too. */
  reversibility_ref: string;
}

export interface InvalidationResult {
  invalidated: boolean;
  changed: Array<keyof ApprovalBindingContext>;
}

/** §23.4 — input for granting an exception (waiver). */
export interface GrantExceptionInput {
  /** Action the waiver covers (exact policy action name). */
  action: string;
  /** Scope: limit the waiver to this task. Omit = any task. */
  task_id?: string;
  /** Granting identity. Must be a human actor — AI cannot self-waive. */
  granted_by: string;
  /** Mandatory justification, kept in the audit trail. */
  reason: string;
  /** TTL override; hard-capped by the manager's exception-grant max TTL. */
  ttlMs?: number;
  /** Risk context for the non-waivable check (BLOCKED is risk-independent). */
  risk_level?: RiskLevel;
}

/** §23.4 — input for revoking an exception grant. */
export interface RevokeExceptionInput {
  /** Revoking identity. Must be a human actor. */
  revoked_by: string;
  reason?: string;
}

/** §23.4 — input for evaluating the approval gate for an action. */
export interface ApprovalGateInput {
  action: string;
  task_id?: string;
  risk_level?: RiskLevel;
  /**
   * When given, an APPROVED approval only counts towards PASS while its
   * bound context still matches (see isUsable()).
   */
  binding?: ApprovalBindingContext;
}

/**
 * §23.4 gate verdicts. WAIVED is deliberately distinct from PASS: the gate
 * failed, and an exception grant waived the failure. (Vocabulary aligned
 * with §39.3 GateVerdict in @ai-factory/core, which also has WAIVED.)
 */
export type ApprovalGateVerdict = 'PASS' | 'FAILED' | 'WAIVED' | 'BLOCKED';

export interface ApprovalGateResult {
  verdict: ApprovalGateVerdict;
  action: string;
  task_id: string;
  /** Human-readable summary of the outcome. */
  reason: string;
  /**
   * The original failure reason — set for FAILED and WAIVED, never erased
   * by a waiver (§23.4: 原 Gate 保留 FAILED/WAIVED，不改为 PASS). Null on PASS.
   */
  failure_reason: string | null;
  /** The usable APPROVED approval behind a PASS; otherwise null. */
  approval_id: string | null;
  /** The exception grant behind a WAIVED; otherwise null. */
  grant_id: string | null;
  /** Who granted the waiver (WAIVED only); otherwise null. */
  granted_by: string | null;
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
  private readonly grants: ExceptionGrantStore;
  private readonly exceptionGrantDefaultTtlMs: number;
  private readonly exceptionGrantMaxTtlMs: number;

  constructor(
    private readonly store: ApprovalStore = new InMemoryApprovalStore(),
    opts: ApprovalManagerOptions = {},
  ) {
    this.audit = opts.audit;
    this.defaultTtlMs = opts.defaultTtlMs ?? DAY_MS;
    this.defaultPolicyVersion = opts.policyVersion ?? 'v1';
    this.grants = opts.exceptionGrants ?? new InMemoryExceptionGrantStore();
    this.exceptionGrantDefaultTtlMs = opts.exceptionGrantDefaultTtlMs ?? DAY_MS;
    this.exceptionGrantMaxTtlMs = opts.exceptionGrantMaxTtlMs ?? 7 * DAY_MS;
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

  // ─── §23.4 Exception Grants ─────────────────────────────────────────────

  private denyGrant(
    entityId: string,
    details: Record<string, unknown>,
    code: ExceptionGrantDeniedError['code'],
    message: string,
  ): never {
    this.audit?.('EXCEPTION_GRANT_DENIED', entityId, { ...details, code });
    throw new ExceptionGrantDeniedError(code, message);
  }

  /**
   * Grant an exception (waiver) for a waivable action. Only a human actor
   * may grant; a reason is mandatory; the TTL is hard-capped so no waiver
   * is permanent; BLOCKED actions are non-waivable invariants and are
   * refused. Every refusal is audited (EXCEPTION_GRANT_DENIED) and every
   * grant is audited (EXCEPTION_GRANT_CREATED).
   */
  grantException(input: GrantExceptionInput): ExceptionGrant {
    if (!input.action) throw new Error('action is required');
    const taskId = input.task_id ?? '';
    const auditDetails = {
      action: input.action,
      task_id: taskId,
      granted_by: input.granted_by ?? '',
    };
    if (!input.granted_by || !isHumanActor(input.granted_by)) {
      this.denyGrant(
        input.action,
        auditDetails,
        'NON_HUMAN_GRANTOR',
        `Exception grants may only be granted by a human actor; '${input.granted_by ?? ''}' is not one — an AI cannot waive its own checks`,
      );
    }
    if (!input.reason || !input.reason.trim()) {
      this.denyGrant(
        input.action,
        auditDetails,
        'REASON_REQUIRED',
        `Exception grant for '${input.action}' requires a reason`,
      );
    }
    const evaluation = evaluateAction(input.action, input.risk_level ?? 'MEDIUM');
    if (evaluation.level === 'BLOCKED') {
      this.denyGrant(
        input.action,
        auditDetails,
        'BLOCKED_ACTION',
        `Action '${input.action}' is BLOCKED by policy — a non-waivable invariant that no exception grant can override`,
      );
    }
    const ttl = input.ttlMs ?? this.exceptionGrantDefaultTtlMs;
    if (!Number.isFinite(ttl) || ttl > this.exceptionGrantMaxTtlMs) {
      this.denyGrant(
        input.action,
        auditDetails,
        'TTL_EXCEEDS_MAX',
        `Exception grant TTL ${ttl}ms exceeds the hard cap of ${this.exceptionGrantMaxTtlMs}ms — permanent or over-long waivers are not allowed`,
      );
    }
    const grant: ExceptionGrant = {
      id: randomUUID(),
      action: input.action,
      task_id: taskId,
      granted_by: input.granted_by,
      reason: input.reason,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + ttl).toISOString(),
      status: 'ACTIVE',
      revoked_by: '',
      revoked_at: null,
      revocation_reason: '',
    };
    this.grants.save(grant);
    this.audit?.('EXCEPTION_GRANT_CREATED', grant.id, {
      action: grant.action,
      task_id: grant.task_id,
      granted_by: grant.granted_by,
      reason: grant.reason,
      expires_at: grant.expires_at,
    });
    return grant;
  }

  getException(id: string): ExceptionGrant {
    const g = this.grants.get(id);
    if (!g) throw new ExceptionGrantNotFoundError(id);
    return g;
  }

  listExceptions(filter?: {
    status?: ExceptionGrantStatus;
    action?: string;
    task_id?: string;
  }): ExceptionGrant[] {
    return this.grants.list(filter);
  }

  /**
   * Revoke an ACTIVE grant. Only a human actor may revoke. Revoking an
   * expired grant first records it EXPIRED; both paths are audited and a
   * non-ACTIVE grant is refused (fail-closed).
   */
  revokeException(id: string, input: RevokeExceptionInput): ExceptionGrant {
    const g = this.getException(id);
    if (!input.revoked_by || !isHumanActor(input.revoked_by)) {
      this.denyGrant(
        id,
        { action: g.action, task_id: g.task_id, revoked_by: input.revoked_by ?? '' },
        'NON_HUMAN_GRANTOR',
        `Exception grants may only be revoked by a human actor; '${input.revoked_by ?? ''}' is not one`,
      );
    }
    if (g.status === 'ACTIVE' && this.isGrantExpired(g)) {
      this.markGrantExpired(g);
      this.denyGrant(
        id,
        { action: g.action, task_id: g.task_id, revoked_by: input.revoked_by },
        'NOT_ACTIVE',
        `Exception grant ${id} already EXPIRED at ${g.expires_at} — nothing to revoke`,
      );
    }
    if (g.status !== 'ACTIVE') {
      this.denyGrant(
        id,
        { action: g.action, task_id: g.task_id, revoked_by: input.revoked_by },
        'NOT_ACTIVE',
        `Exception grant ${id} is ${g.status}, not ACTIVE — cannot revoke`,
      );
    }
    const revoked: ExceptionGrant = {
      ...g,
      status: 'REVOKED',
      revoked_by: input.revoked_by,
      revoked_at: nowIso(),
      revocation_reason: input.reason ?? '',
    };
    this.grants.save(revoked);
    this.audit?.('EXCEPTION_GRANT_REVOKED', revoked.id, {
      action: revoked.action,
      task_id: revoked.task_id,
      granted_by: revoked.granted_by,
      revoked_by: revoked.revoked_by,
      reason: revoked.revocation_reason,
    });
    return revoked;
  }

  /** Mark every overdue ACTIVE grant EXPIRED (audited each). */
  sweepExpiredGrants(): ExceptionGrant[] {
    const expired: ExceptionGrant[] = [];
    for (const g of this.grants.list({ status: 'ACTIVE' })) {
      if (this.isGrantExpired(g)) expired.push(this.markGrantExpired(g));
    }
    return expired;
  }

  private isGrantExpired(g: ExceptionGrant): boolean {
    return Date.now() >= new Date(g.expires_at).getTime();
  }

  private markGrantExpired(g: ExceptionGrant): ExceptionGrant {
    const expired: ExceptionGrant = { ...g, status: 'EXPIRED' };
    this.grants.save(expired);
    this.audit?.('EXCEPTION_GRANT_EXPIRED', expired.id, {
      action: expired.action,
      task_id: expired.task_id,
      granted_by: expired.granted_by,
      expires_at: expired.expires_at,
    });
    return expired;
  }

  /**
   * The live grant covering (action, task), if any. Task-specific grants
   * win over any-task grants. An expired ACTIVE grant encountered here is
   * marked EXPIRED (audited) and never applies — fail-closed.
   */
  private activeGrantFor(action: string, taskId: string): ExceptionGrant | undefined {
    const covering = this.grants
      .list({ status: 'ACTIVE', action })
      .filter((g) => g.task_id === '' || g.task_id === taskId)
      .sort((x, y) => {
        const specX = x.task_id === taskId && taskId !== '' ? 0 : 1;
        const specY = y.task_id === taskId && taskId !== '' ? 0 : 1;
        return specX - specY || x.created_at.localeCompare(y.created_at);
      });
    for (const g of covering) {
      if (this.isGrantExpired(g)) {
        this.markGrantExpired(g);
        continue;
      }
      return g;
    }
    return undefined;
  }

  /** Why the approval requirement is unmet — the original gate failure. */
  private gateFailureReason(approvals: Approval[], action: string, taskId: string): string {
    const latest = [...approvals].sort((x, y) =>
      y.created_at.localeCompare(x.created_at),
    )[0];
    if (!latest) {
      return `no approval exists for action '${action}' on task '${taskId}'`;
    }
    switch (latest.status) {
      case 'REJECTED':
        return `approval ${latest.approval_id} REJECTED by ${latest.decided_by}${latest.decision_reason ? `: ${latest.decision_reason}` : ''}`;
      case 'INVALIDATED':
        return `approval ${latest.approval_id} INVALIDATED (${latest.decision_reason})`;
      case 'PENDING':
        return `approval ${latest.approval_id} is still PENDING`;
      case 'EXPIRED':
        return `approval ${latest.approval_id} EXPIRED`;
      case 'CANCELLED':
        return `approval ${latest.approval_id} CANCELLED`;
      case 'APPROVED':
        return `approval ${latest.approval_id} is APPROVED but its bound context no longer matches`;
    }
  }

  /**
   * §23.4 gate evaluation for an action: the consumption point for
   * exception grants.
   *
   *  - BLOCKED action → BLOCKED (non-waivable; audited). Grants never apply.
   *  - AUTO action → PASS (no approval requirement to fail).
   *  - usable APPROVED approval → PASS, with the approval id.
   *  - otherwise the gate FAILED; if a live exception grant covers the
   *    action/scope, the verdict is WAIVED — the original failure_reason is
   *    preserved verbatim and the waiver is audited (APPROVAL_GATE_WAIVED).
   *    WAIVED is never PASS and never produces an approval.
   */
  evaluateApprovalGate(input: ApprovalGateInput): ApprovalGateResult {
    const taskId = input.task_id ?? '';
    const evaluation = evaluateAction(input.action, input.risk_level ?? 'MEDIUM');
    const base = {
      action: input.action,
      task_id: taskId,
      approval_id: null,
      grant_id: null,
      granted_by: null,
    };
    if (evaluation.level === 'BLOCKED') {
      this.audit?.('APPROVAL_GATE_BLOCKED', input.action, {
        action: input.action,
        task_id: taskId,
        failure_reason: evaluation.reason,
      });
      return {
        ...base,
        verdict: 'BLOCKED',
        failure_reason: evaluation.reason,
        reason: evaluation.reason,
      };
    }
    if (!evaluation.requiresApproval) {
      return {
        ...base,
        verdict: 'PASS',
        failure_reason: null,
        reason: evaluation.reason,
      };
    }
    const approvals = this.store
      .listByTask(taskId)
      .filter((a) => a.action === input.action);
    const usable = approvals.find(
      (a) =>
        a.status === 'APPROVED' &&
        (!input.binding || this.isUsable(a, input.binding)),
    );
    if (usable) {
      return {
        ...base,
        verdict: 'PASS',
        approval_id: usable.approval_id,
        failure_reason: null,
        reason: `usable APPROVED approval ${usable.approval_id}`,
      };
    }
    const failureReason = this.gateFailureReason(approvals, input.action, taskId);
    const grant = this.activeGrantFor(input.action, taskId);
    if (grant) {
      this.audit?.('APPROVAL_GATE_WAIVED', grant.id, {
        action: input.action,
        task_id: taskId,
        grant_id: grant.id,
        granted_by: grant.granted_by,
        grant_reason: grant.reason,
        failure_reason: failureReason,
      });
      return {
        ...base,
        verdict: 'WAIVED',
        grant_id: grant.id,
        granted_by: grant.granted_by,
        failure_reason: failureReason,
        reason:
          `gate FAILED (${failureReason}) but WAIVED by exception grant ${grant.id} ` +
          `granted by ${grant.granted_by}: ${grant.reason}`,
      };
    }
    return { ...base, verdict: 'FAILED', failure_reason: failureReason, reason: failureReason };
  }
}
