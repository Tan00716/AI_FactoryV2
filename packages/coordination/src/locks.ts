/**
 * Task locking — spec §63.
 *
 * Six lock kinds: file / resource / task / branch / environment / deployment.
 *
 * - acquire(kind, key, holder, ttlMs): grants the lock when free (or when a
 *   previous holder's TTL has expired); otherwise returns a rejected/
 *   queued outcome instead of blocking.
 * - release(token): releases a held lock; the first queued waiter is
 *   auto-granted (FIFO).
 * - TTL expiry is clock-injected so tests are deterministic: pass
 *   { clock: { now: () => t } } to control time.
 * - PROD deployment lock is globally single-active: at most one holder of
 *   (deployment, 'prod') at a time; a second acquire is rejected and queued.
 * - Every acquire / release / rejection / expiry goes through the injected
 *   audit hook.
 */

import { randomUUID } from 'crypto';

export type LockKind =
  | 'file'
  | 'resource'
  | 'task'
  | 'branch'
  | 'environment'
  | 'deployment';

export type LockEventType =
  | 'acquired'
  | 'released'
  | 'rejected'
  | 'expired'
  | 'auto_granted';

export interface LockEvent {
  type: LockEventType;
  kind: LockKind;
  key: string;
  holder: string;
  token: string | null;
  /** Epoch ms from the injected clock. */
  at: number;
  reason?: string;
}

export type LockAuditHook = (event: LockEvent) => void;

export interface Clock {
  now: () => number;
}

export interface AcquireOutcome {
  granted: boolean;
  /** Opaque token for release(); null when not granted. */
  token: string | null;
  /** True when the request was queued behind the current holder. */
  queued: boolean;
  /** Current holder when rejected/queued, otherwise null. */
  heldBy: string | null;
  reason?: string;
}

export interface HeldLock {
  kind: LockKind;
  key: string;
  holder: string;
  token: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LockManagerOptions {
  clock?: Clock;
  audit?: LockAuditHook;
  uuid?: () => string;
}

interface Waiter {
  holder: string;
  ttlMs: number;
}

export class LockManager {
  private readonly locks = new Map<string, HeldLock>();
  private readonly tokenIndex = new Map<string, string>(); // token → lock key
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly clock: Clock;
  private readonly auditHook?: LockAuditHook;
  private readonly uuid: () => string;

  constructor(opts: LockManagerOptions = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.auditHook = opts.audit;
    this.uuid = opts.uuid ?? randomUUID;
  }

  /** Canonical lock key: "<kind>:<key>" — e.g. "deployment:prod". */
  static lockKey(kind: LockKind, key: string): string {
    return `${kind}:${key}`;
  }

  /** True for the globally single-active PROD deployment lock. */
  static isProdDeployment(kind: LockKind, key: string): boolean {
    return kind === 'deployment' && key === 'prod';
  }

  private emit(event: Omit<LockEvent, 'at'>): void {
    if (!this.auditHook) return;
    try {
      this.auditHook({ ...event, at: this.clock.now() });
    } catch {
      // Audit must never break lock semantics.
    }
  }

  /** Release any lock whose TTL has elapsed (also called lazily on access). */
  sweep(): string[] {
    const expired: string[] = [];
    const now = this.clock.now();
    for (const [lockKey, lock] of [...this.locks]) {
      if (lock.expiresAt <= now) {
        this.locks.delete(lockKey);
        this.tokenIndex.delete(lock.token);
        expired.push(lockKey);
        this.emit({
          type: 'expired',
          kind: lock.kind,
          key: lock.key,
          holder: lock.holder,
          token: lock.token,
          reason: `TTL ${lock.expiresAt - lock.acquiredAt}ms elapsed`,
        });
        this.grantNextWaiter(lockKey, lock.kind, lock.key);
      }
    }
    return expired;
  }

  /** Grant the first queued waiter for a freed lock (FIFO). */
  private grantNextWaiter(lockKey: string, kind: LockKind, key: string): void {
    const queue = this.waiters.get(lockKey);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.waiters.delete(lockKey);
    if (next) {
      const granted = this.grant(kind, key, next.holder, next.ttlMs);
      this.emit({
        type: 'auto_granted',
        kind,
        key,
        holder: next.holder,
        token: granted.token,
        reason: 'FIFO waiter granted after lock freed',
      });
    }
  }

  private grant(kind: LockKind, key: string, holder: string, ttlMs: number): HeldLock {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive number');
    }
    const now = this.clock.now();
    const lockKey = LockManager.lockKey(kind, key);
    const lock: HeldLock = {
      kind,
      key,
      holder,
      token: this.uuid(),
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.locks.set(lockKey, lock);
    this.tokenIndex.set(lock.token, lockKey);
    this.emit({ type: 'acquired', kind, key, holder, token: lock.token });
    return lock;
  }

  /**
   * Acquire a lock. Never blocks: returns { granted:false, queued:true }
   * when the lock is held (PROD deployment: second acquire is rejected and
   * queued behind the single active holder).
   */
  acquire(kind: LockKind, key: string, holder: string, ttlMs: number): AcquireOutcome {
    if (!holder) throw new TypeError('holder is required');
    this.sweep();
    const lockKey = LockManager.lockKey(kind, key);
    const held = this.locks.get(lockKey);
    if (!held) {
      const lock = this.grant(kind, key, holder, ttlMs);
      return { granted: true, token: lock.token, queued: false, heldBy: null };
    }

    // Same holder re-acquiring refreshes the TTL (re-entrant for the owner).
    if (held.holder === holder) {
      held.expiresAt = this.clock.now() + ttlMs;
      this.emit({
        type: 'acquired',
        kind,
        key,
        holder,
        token: held.token,
        reason: 'TTL refreshed for current holder',
      });
      return { granted: true, token: held.token, queued: false, heldBy: null };
    }

    const queue = this.waiters.get(lockKey) ?? [];
    if (!queue.some((w) => w.holder === holder)) {
      queue.push({ holder, ttlMs });
      this.waiters.set(lockKey, queue);
    }
    const reason = LockManager.isProdDeployment(kind, key)
      ? 'PROD allows a single active deployment — queued behind the current holder'
      : `Lock held by ${held.holder} — queued`;
    this.emit({
      type: 'rejected',
      kind,
      key,
      holder,
      token: null,
      reason,
    });
    return { granted: false, token: null, queued: true, heldBy: held.holder, reason };
  }

  /**
   * Release a lock by token. Auto-grants the first queued waiter (FIFO),
   * which is audited as 'auto_granted'.
   */
  release(token: string): boolean {
    this.sweep();
    const lockKey = this.tokenIndex.get(token);
    if (!lockKey) return false;
    const lock = this.locks.get(lockKey)!;
    this.locks.delete(lockKey);
    this.tokenIndex.delete(token);
    this.emit({
      type: 'released',
      kind: lock.kind,
      key: lock.key,
      holder: lock.holder,
      token,
    });
    this.grantNextWaiter(lockKey, lock.kind, lock.key);
    return true;
  }

  /** Current lock state, or undefined when free. */
  peek(kind: LockKind, key: string): HeldLock | undefined {
    this.sweep();
    const lock = this.locks.get(LockManager.lockKey(kind, key));
    return lock ? { ...lock } : undefined;
  }

  /** True when the given holder currently holds the lock. */
  isHeldBy(kind: LockKind, key: string, holder: string): boolean {
    return this.peek(kind, key)?.holder === holder;
  }

  /** Holders waiting behind the current holder, FIFO order. */
  pendingWaiters(kind: LockKind, key: string): string[] {
    return (this.waiters.get(LockManager.lockKey(kind, key)) ?? []).map((w) => w.holder);
  }

  /** All currently held locks (snapshot). */
  activeLocks(): HeldLock[] {
    this.sweep();
    return [...this.locks.values()].map((l) => ({ ...l }));
  }
}
