/**
 * Exception Grants — SPEC v2 §23.4.
 *
 * A legitimate Human may waive a *waivable* rule through a time-limited,
 * scoped, audited Exception Grant. The gate keeps its original verdict:
 * FAILED becomes WAIVED — never PASS. A waiver does not manufacture an
 * approval, does not rewrite the underlying decision, and does not touch
 * non-waivable invariants: actions policy marks BLOCKED (BLOCKED_ACTIONS,
 * e.g. 'secret.write') can never be granted, applied, or waived.
 *
 * Fail-closed throughout:
 *  - only human actors may grant or revoke (an AI cannot issue its own
 *    waiver — same identity convention as §23.3 required_approvers);
 *  - a reason is mandatory;
 *  - expires_at is always set and the TTL is hard-capped — permanent
 *    exception grants do not exist;
 *  - expired or revoked grants never apply.
 */

/** Lifecycle of an exception grant. EXPIRED is reached via sweep/encounter. */
export type ExceptionGrantStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface ExceptionGrant {
  /** Grant id (uuid). */
  id: string;
  /** Action covered — exact policy action name, e.g. 'deploy.prod'. */
  action: string;
  /**
   * Scope: the task the waiver is limited to. '' means the waiver applies
   * to any task — still action-exact, time-boxed, human-granted and audited.
   */
  task_id: string;
  /** Granting identity; always a human actor ('human' or 'human:<name>'). */
  granted_by: string;
  /** Mandatory justification, recorded in the audit trail. */
  reason: string;
  /** Creation timestamp (ISO). */
  created_at: string;
  /** Expiry timestamp (ISO). Always set — no permanent grants. */
  expires_at: string;
  status: ExceptionGrantStatus;
  /** Revoking identity ('' while not revoked). */
  revoked_by: string;
  /** Revocation timestamp; null while not revoked. */
  revoked_at: string | null;
  /** Revocation rationale ('' while not revoked). */
  revocation_reason: string;
}

/** Minimal storage contract — in-memory here, mirroring ApprovalStore. */
export interface ExceptionGrantStore {
  save(g: ExceptionGrant): void;
  get(id: string): ExceptionGrant | undefined;
  list(filter?: {
    status?: ExceptionGrantStatus;
    action?: string;
    task_id?: string;
  }): ExceptionGrant[];
}

function copyGrant(g: ExceptionGrant): ExceptionGrant {
  return { ...g };
}

export class InMemoryExceptionGrantStore implements ExceptionGrantStore {
  private map = new Map<string, ExceptionGrant>();

  save(g: ExceptionGrant): void {
    this.map.set(g.id, copyGrant(g));
  }

  get(id: string): ExceptionGrant | undefined {
    const g = this.map.get(id);
    return g ? copyGrant(g) : undefined;
  }

  list(
    filter: {
      status?: ExceptionGrantStatus;
      action?: string;
      task_id?: string;
    } = {},
  ): ExceptionGrant[] {
    return [...this.map.values()]
      .filter(
        (g) =>
          (filter.status === undefined || g.status === filter.status) &&
          (filter.action === undefined || g.action === filter.action) &&
          (filter.task_id === undefined || g.task_id === filter.task_id),
      )
      .sort((x, y) => x.created_at.localeCompare(y.created_at))
      .map(copyGrant);
  }
}

export class ExceptionGrantNotFoundError extends Error {
  constructor(id: string) {
    super(`Exception grant ${id} not found`);
    this.name = 'ExceptionGrantNotFoundError';
  }
}

/** Machine-readable reason an exception-grant operation was refused. */
export type ExceptionGrantDenyCode =
  /** The action is a non-waivable invariant (policy BLOCKED). */
  | 'BLOCKED_ACTION'
  /** Only human actors may grant/revoke exceptions. */
  | 'NON_HUMAN_GRANTOR'
  /** A justification is mandatory. */
  | 'REASON_REQUIRED'
  /** Requested TTL exceeds the manager's hard cap (no permanent waivers). */
  | 'TTL_EXCEEDS_MAX'
  /** The grant is no longer ACTIVE (expired or already revoked). */
  | 'NOT_ACTIVE';

/**
 * Thrown when an exception grant is refused. Every refusal is also written
 * to the audit trail (EXCEPTION_GRANT_DENIED) before this is thrown.
 */
export class ExceptionGrantDeniedError extends Error {
  readonly code: ExceptionGrantDenyCode;

  constructor(code: ExceptionGrantDenyCode, message: string) {
    super(message);
    this.name = 'ExceptionGrantDeniedError';
    this.code = code;
  }
}

/**
 * Is this identity a human actor? Same role-prefix convention as §23.3
 * deciderSatisfies(): 'human' matches 'human' and 'human:<name>'; anything
 * else ('agent:…', 'ai:…', 'rogue-agent') is not a human.
 */
export function isHumanActor(identity: string): boolean {
  return identity === 'human' || identity.startsWith('human:');
}
