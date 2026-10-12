/**
 * Lease and lock types — SPEC v2 §22.
 */

/**
 * Durable lease (§22.3). Exactly one valid writer per resource; `generation`
 * and `fencing_token` increase monotonically on every reassignment/takeover/
 * recovery so an old owner can never write again.
 */
export interface Lease {
  id: string;
  resource_id: string;
  owner_run_id: string;
  generation: number;
  fencing_token: number;
  expires_at: string;
  renew_sequence: number;
  created_at: string;
}

export class LeaseConflictError extends Error {
  readonly code = 'LEASE_CONFLICT';
  readonly reasonCode = 'VERSION_CONFLICT' as const;
  constructor(
    readonly resourceId: string,
    readonly holder: string,
  ) {
    super(`resource '${resourceId}' already leased by run '${holder}'`);
    this.name = 'LeaseConflictError';
  }
}

export class StaleOwnerError extends Error {
  readonly code = 'STALE_OWNER';
  readonly reasonCode = 'STALE_OWNER' as const;
  constructor(
    readonly resourceId: string,
    readonly detail: string,
  ) {
    super(`STALE_OWNER: write rejected for '${resourceId}' — ${detail}`);
    this.name = 'StaleOwnerError';
  }
}

export class LeaseNotFoundError extends Error {
  readonly code = 'LEASE_NOT_FOUND';
  constructor(readonly leaseId: string) {
    super(`lease not found: ${leaseId}`);
    this.name = 'LeaseNotFoundError';
  }
}

/** Resource lock kinds (§22.2). Rank defines the global acquisition order. */
export type LockKind =
  | 'task'
  | 'file'
  | 'resource'
  | 'branch'
  | 'environment'
  | 'deployment';

export const LOCK_KIND_RANK: Record<LockKind, number> = {
  task: 1,
  file: 2,
  resource: 3,
  branch: 4,
  environment: 5,
  deployment: 6,
};

export interface LockRequest {
  kind: LockKind;
  /** e.g. 'file:/ws/a/b.ts', 'deployment:myproj:prod'. */
  key: string;
  owner: string;
  ttlMs: number;
}

export interface LockGrant {
  kind: LockKind;
  key: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  constructor(
    readonly keys: string[],
    /** How long the caller actually waited before giving up, in ms (0 = single-shot, no wait). */
    readonly waitedMs = 0,
  ) {
    super(
      `could not acquire locks in time: ${keys.join(', ')}` +
        (waitedMs > 0 ? ` (waited ${waitedMs}ms)` : ''),
    );
    this.name = 'LockTimeoutError';
  }
}
