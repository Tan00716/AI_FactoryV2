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
  /**
   * Blocking sleep used by the acquisition wait loops, in milliseconds.
   * Defaults to a real `Atomics.wait` sleep. Inject together with `now`:
   * a custom sleep MUST advance the `now` clock by roughly the slept
   * duration (a real sleep does exactly that to a real clock). Tests
   * inject a fake sleep that advances their fake clock, which is what
   * makes waiting deterministic there.
   */
  sleep?: (ms: number) => void;
}

interface HeldLock extends LockGrant {
  timer?: never;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Upper bound for one wait slice. A wait sleeps until the conflicting lock
 * expires, but wakes at least this often to re-check (a lock can also
 * disappear before its TTL via release/prune).
 */
const MAX_POLL_MS = 50;

/**
 * Default blocking sleep. `Atomics.wait` parks the calling thread; unlike
 * browsers, Node permits it on the main thread. Nothing ever notifies this
 * cell, so it always sleeps the full duration.
 */
function defaultSleepMs(ms: number): void {
  if (ms <= 0) return;
  if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, ms);
    return;
  }
  // Last-resort fallback for runtimes without SharedArrayBuffer.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

/**
 * Waiting is BLOCKING and synchronous — deliberately. The public API is
 * sync (apps/server lock routes call it inline and serialize the return
 * value), so a wait parks the calling thread via the sleep above. Because
 * lock state lives in this process, the only state change a waiter can
 * observe while parked is TTL expiry; the poll cap just bounds re-check
 * latency. Callers that cannot afford to block should pass timeoutMs 0
 * (the default) and handle LockTimeoutError themselves.
 */
export class ResourceLockManager {
  private readonly held = new Map<string, HeldLock>(); // lockKey → grant

  constructor(private readonly opts: LockManagerOptions = {}) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private sleepMs(ms: number): void {
    if (ms <= 0) return;
    if (this.opts.sleep) this.opts.sleep(ms);
    else defaultSleepMs(ms);
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
   * One atomic acquisition pass over the globally ordered requests. On
   * conflict, every grant taken during this pass is rolled back before
   * returning, so a failed pass never leaves partial holdings behind.
   */
  private attempt(
    ordered: LockRequest[],
  ): { grants: LockGrant[] } | { blocker: HeldLock; blockerKey: string } {
    const acquired: LockGrant[] = [];
    for (const req of ordered) {
      const lk = this.lockKey(req.kind, req.key);
      const existing = this.held.get(lk);
      if (existing && this.isLive(existing)) {
        for (const g of acquired) this.held.delete(this.lockKey(g.kind, g.key));
        return { blocker: existing, blockerKey: lk };
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
    return { grants: acquired };
  }

  /**
   * Acquire one lock. When another live holder owns it, waits — in
   * slices bounded by the holder's remaining TTL — until the lock frees
   * up or timeoutMs elapses, then throws LockTimeoutError carrying the
   * waited duration. timeoutMs 0 (default) is a single-shot attempt:
   * conflict throws immediately. Shares acquireAll's wait semantics by
   * delegating to it with a single request.
   */
  acquire(kind: LockKind, key: string, owner: string, ttlMs: number, timeoutMs = 0): LockGrant {
    return this.acquireAll([{ kind, key, owner, ttlMs }], { timeoutMs })[0];
  }

  /**
   * Acquire several locks atomically in global order (kind rank, then key).
   * On conflict the call waits (see class doc) and retries until every
   * lock is held or the deadline passes; a failed call — after any amount
   * of waiting — holds nothing: no partial holdings, no opposite-order
   * deadlocks. timeoutMs 0/omitted means a single attempt, as before.
   */
  acquireAll(requests: LockRequest[], opts: { timeoutMs?: number } = {}): LockGrant[] {
    const ordered = [...requests].sort(
      (a, b) => LOCK_KIND_RANK[a.kind] - LOCK_KIND_RANK[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const start = this.nowMs();
    const deadline = start + timeoutMs;
    let sleptMs = 0;
    for (;;) {
      this.prune();
      const r = this.attempt(ordered);
      if ('grants' in r) return r.grants;
      // Conflict. The wait is bounded by BOTH the clock deadline and the
      // accumulated sleep budget, so the loop terminates even if an
      // injected clock/sleep pair is mismatched (sleep not advancing the
      // clock). nowMs() remains the only clock the logic reads.
      const now = this.nowMs();
      const remaining = Math.min(deadline - now, timeoutMs - sleptMs);
      if (remaining <= 0) {
        throw new LockTimeoutError([r.blockerKey], Math.max(now - start, sleptMs));
      }
      // Sleep until the blocker expires, waking at least every
      // MAX_POLL_MS to notice an earlier release/prune.
      const blockerTtlLeft = new Date(r.blocker.expiresAt).getTime() - now;
      const waitMs = Math.max(1, Math.min(blockerTtlLeft, MAX_POLL_MS, remaining));
      this.sleepMs(waitMs);
      sleptMs += waitMs;
    }
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
