/**
 * Durable lease manager — SPEC v2 §22.3.
 *
 * One valid writer per resource. The fencing token is checked at the FINAL
 * execution point (not just when the orchestrator starts the work): any
 * write carrying an old token is rejected as STALE_OWNER.
 *
 * Clock is injectable for deterministic tests.
 */
import { randomUUID } from 'node:crypto';
import {
  Lease,
  LeaseConflictError,
  LeaseNotFoundError,
  StaleOwnerError,
} from './types';

export interface LeaseManagerOptions {
  now?: () => number;
}

interface LeaseState extends Lease {
  revoked: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class LeaseManager {
  private readonly leases = new Map<string, LeaseState>(); // leaseId → state
  private readonly byResource = new Map<string, string>(); // resourceId → leaseId

  constructor(private readonly opts: LeaseManagerOptions = {}) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private current(resourceId: string): LeaseState | undefined {
    const id = this.byResource.get(resourceId);
    if (!id) return undefined;
    const lease = this.leases.get(id);
    if (!lease || lease.revoked) return undefined;
    if (this.nowMs() >= new Date(lease.expires_at).getTime()) return undefined;
    return lease;
  }

  /**
   * Acquire the single-writer lease. Throws LeaseConflictError when a valid
   * lease already exists.
   */
  acquire(resourceId: string, ownerRunId: string, ttlMs: number): Lease {
    const existing = this.current(resourceId);
    if (existing) throw new LeaseConflictError(resourceId, existing.owner_run_id);
    const t = this.nowMs();
    const lease: LeaseState = {
      id: randomUUID(),
      resource_id: resourceId,
      owner_run_id: ownerRunId,
      generation: 1,
      fencing_token: 1,
      expires_at: iso(t + ttlMs),
      renew_sequence: 0,
      created_at: iso(t),
      revoked: false,
    };
    this.leases.set(lease.id, lease);
    this.byResource.set(resourceId, lease.id);
    return this.public(lease);
  }

  /**
   * Renew: extends expiry and bumps renew_sequence. The fencing token must
   * match — a token from a superseded generation is STALE_OWNER.
   */
  renew(leaseId: string, fencingToken: number, ttlMs: number): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.revoked) throw new LeaseNotFoundError(leaseId);
    if (lease.fencing_token !== fencingToken) {
      throw new StaleOwnerError(lease.resource_id, 'fencing token does not match current generation');
    }
    if (this.nowMs() >= new Date(lease.expires_at).getTime()) {
      throw new StaleOwnerError(lease.resource_id, 'lease expired');
    }
    lease.expires_at = iso(this.nowMs() + ttlMs);
    lease.renew_sequence += 1;
    return this.public(lease);
  }

  release(leaseId: string, fencingToken: number): void {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.revoked) throw new LeaseNotFoundError(leaseId);
    if (lease.fencing_token !== fencingToken) {
      throw new StaleOwnerError(lease.resource_id, 'fencing token does not match; cannot release');
    }
    lease.revoked = true;
    if (this.byResource.get(lease.resource_id) === leaseId) {
      this.byResource.delete(lease.resource_id);
    }
  }

  /**
   * Reassign / takeover / worker recovery: generation AND fencing_token
   * increase monotonically. The old owner's token stops working everywhere —
   * including writes already in flight (§22.3).
   */
  reassign(resourceId: string, newOwnerRunId: string, ttlMs: number): Lease {
    const id = this.byResource.get(resourceId);
    const prev = id ? this.leases.get(id) : undefined;
    const t = this.nowMs();
    const lease: LeaseState = {
      id: randomUUID(),
      resource_id: resourceId,
      owner_run_id: newOwnerRunId,
      generation: (prev?.generation ?? 0) + 1,
      fencing_token: (prev?.fencing_token ?? 0) + 1,
      expires_at: iso(t + ttlMs),
      renew_sequence: 0,
      created_at: iso(t),
      revoked: false,
    };
    if (prev) prev.revoked = true;
    this.leases.set(lease.id, lease);
    this.byResource.set(resourceId, lease.id);
    return this.public(lease);
  }

  /**
   * Final-execution-point check. Call this at the moment of the write/deploy,
   * not just when the work started. Throws StaleOwnerError for expired
   * owners, superseded generations, and revoked leases.
   */
  validate(resourceId: string, fencingToken: number): Lease {
    const lease = this.current(resourceId);
    if (!lease) {
      throw new StaleOwnerError(resourceId, 'no valid lease (expired, released, or never acquired)');
    }
    if (lease.fencing_token !== fencingToken) {
      throw new StaleOwnerError(
        resourceId,
        `token ${fencingToken} superseded by generation ${lease.generation} (token ${lease.fencing_token})`,
      );
    }
    return this.public(lease);
  }

  get(resourceId: string): Lease | undefined {
    const lease = this.current(resourceId);
    return lease ? this.public(lease) : undefined;
  }

  private public(lease: LeaseState): Lease {
    const { revoked: _revoked, ...pub } = lease;
    void _revoked;
    return pub;
  }
}
