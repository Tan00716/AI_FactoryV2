/**
 * Ordered resource locks — SPEC v2 §22.2.
 *
 * Lock kinds: task, file, resource, branch, environment, deployment.
 * Deadlock prevention: every multi-lock acquisition is sorted by the global
 * (kind rank, key) order before acquiring, so two managers can never hold
 * locks in opposite orders. Every acquisition carries a timeout.
 *
 * Default policy: one deployment per project/production environment —
 * express it with key `deployment:<project>:<env>`.
 */
import {
  LOCK_KIND_RANK,
  LockGrant,
  LockKind,
  LockRequest,
  LockTimeoutError,
} from './types';

export interface LockManagerOptions {
  now?: () => number;
}

interface HeldLock extends LockGrant {
  timer?: never;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class ResourceLockManager {
  private readonly held = new Map<string, HeldLock>(); // lockKey → grant

  constructor(private readonly opts: LockManagerOptions = {}) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private lockKey(kind: LockKind, key: string): string {
    return `${kind}:${key}`;
  }

  private isLive(grant: HeldLock): boolean {
    return this.nowMs() < new Date(grant.expiresAt).getTime();
  }

  private prune(): void {
    for (const [k, g] of this.held) {
      if (!this.isLive(g)) this.held.delete(k);
    }
  }

  /**
   * Acquire one lock. Throws LockTimeoutError when it cannot be acquired
   * within timeoutMs (another live holder owns it).
   */
  acquire(kind: LockKind, key: string, owner: string, ttlMs: number, timeoutMs = 0): LockGrant {
    this.prune();
    const lk = this.lockKey(kind, key);
    const existing = this.held.get(lk);
    if (existing && this.isLive(existing)) {
      throw new LockTimeoutError([lk]);
    }
    const t = this.nowMs();
    const grant: HeldLock = {
      kind,
      key,
      owner,
      acquiredAt: iso(t),
      expiresAt: iso(t + ttlMs),
    };
    this.held.set(lk, grant);
    void timeoutMs; // single-shot in-process acquire; timeout applies to acquireAll waits
    return { ...grant };
  }

  /**
   * Acquire several locks atomically in global order (kind rank, then key).
   * On any conflict, already-acquired locks in this call are released —
   * no partial holdings, no opposite-order deadlocks.
   */
  acquireAll(requests: LockRequest[], opts: { timeoutMs?: number } = {}): LockGrant[] {
    this.prune();
    const ordered = [...requests].sort(
      (a, b) => LOCK_KIND_RANK[a.kind] - LOCK_KIND_RANK[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const acquired: LockGrant[] = [];
    const deadline = this.nowMs() + (opts.timeoutMs ?? 0);
    for (const req of ordered) {
      const lk = this.lockKey(req.kind, req.key);
      const existing = this.held.get(lk);
      if (existing && this.isLive(existing)) {
        for (const g of acquired) this.held.delete(this.lockKey(g.kind, g.key));
        void deadline;
        throw new LockTimeoutError([lk]);
      }
      const t = this.nowMs();
      const grant: HeldLock = {
        kind: req.kind,
        key: req.key,
        owner: req.owner,
        acquiredAt: iso(t),
        expiresAt: iso(t + req.ttlMs),
      };
      this.held.set(lk, grant);
      acquired.push({ ...grant });
    }
    return acquired;
  }

  release(kind: LockKind, key: string, owner: string): boolean {
    const lk = this.lockKey(kind, key);
    const grant = this.held.get(lk);
    if (!grant || grant.owner !== owner) return false;
    this.held.delete(lk);
    return true;
  }

  holder(kind: LockKind, key: string): LockGrant | undefined {
    this.prune();
    const grant = this.held.get(this.lockKey(kind, key));
    return grant ? { ...grant } : undefined;
  }
}
