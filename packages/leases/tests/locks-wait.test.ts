/**
 * ResourceLockManager wait semantics — SPEC v2 §22.2 (Batch 7-4).
 *
 * timeoutMs used to be decorative: acquireAll computed a deadline and
 * then threw on first conflict (`void deadline`). These tests pin the
 * real behavior: wait in TTL-bounded slices until the conflicting lock
 * expires, give up at the deadline with the waited duration on the
 * error, and never leave partial holdings behind.
 *
 * Deterministic by construction: the fake sleep advances the fake clock
 * by exactly the slept amount and records every slice, so "waiting
 * happened" is asserted from the clock, not from wall time. Two small
 * real-clock cases (≈270ms total) cover the default Atomics.wait sleep.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LockTimeoutError, ResourceLockManager } from '../src/index';

const T0 = 1_700_000_000_000;

function fakeManager() {
  let t = T0;
  const sleeps: number[] = [];
  const mgr = new ResourceLockManager({
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { mgr, sleeps, now: () => t, sleptTotal: () => sleeps.reduce((a, b) => a + b, 0) };
}

describe('ResourceLockManager — acquireAll really waits (§22.2)', () => {
  it('waits for the conflicting lock to expire, then acquires atomically', () => {
    const { mgr, sleeps, now, sleptTotal } = fakeManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 1_000);

    const grants = mgr.acquireAll(
      [{ kind: 'deployment', key: 'proj:prod', owner: 'run-B', ttlMs: 60_000 }],
      { timeoutMs: 5_000 },
    );

    assert.equal(grants.length, 1);
    assert.equal(grants[0].owner, 'run-B');
    // Waiting demonstrably happened: the clock advanced by exactly the
    // blocker's TTL, in poll-capped slices, and the grant starts then.
    assert.ok(sleeps.length > 0, 'sleep must have been called');
    assert.ok(sleeps.every((s) => s <= 50), 'slices are poll-capped');
    assert.equal(sleptTotal(), 1_000);
    assert.equal(now() - T0, 1_000);
    assert.equal(grants[0].acquiredAt, new Date(T0 + 1_000).toISOString());
    assert.equal(mgr.holder('deployment', 'proj:prod')?.owner, 'run-B');
  });

  it('times out at the deadline: error names the lock + waited ms, partial holdings rolled back', () => {
    const { mgr, now, sleptTotal } = fakeManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 60_000);

    let err: unknown;
    try {
      mgr.acquireAll(
        [
          { kind: 'task', key: 'TASK-9', owner: 'run-C', ttlMs: 60_000 },
          { kind: 'deployment', key: 'proj:prod', owner: 'run-C', ttlMs: 60_000 },
        ],
        { timeoutMs: 500 },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LockTimeoutError);
    assert.deepEqual(err.keys, ['deployment:proj:prod']);
    assert.equal(err.waitedMs, 500);
    assert.match(err.message, /could not acquire locks in time: deployment:proj:prod \(waited 500ms\)/);
    assert.equal(now() - T0, 500);
    assert.equal(sleptTotal(), 500);
    // No partial holdings: the task lock (earlier in global order, taken
    // on every attempt) is released; the blocker is untouched.
    assert.equal(mgr.holder('task', 'TASK-9'), undefined);
    assert.equal(mgr.holder('deployment', 'proj:prod')?.owner, 'run-A');
  });

  it('timeoutMs 0 or omitted keeps the old single-shot behavior (no sleep, clock untouched)', () => {
    const { mgr, sleeps, now } = fakeManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 60_000);

    assert.throws(
      () => mgr.acquireAll([{ kind: 'deployment', key: 'proj:prod', owner: 'run-B', ttlMs: 60_000 }], { timeoutMs: 0 }),
      LockTimeoutError,
    );
    assert.throws(
      () => mgr.acquireAll([{ kind: 'deployment', key: 'proj:prod', owner: 'run-B', ttlMs: 60_000 }]),
      LockTimeoutError,
    );
    assert.throws(
      () => mgr.acquire('deployment', 'proj:prod', 'run-B', 60_000),
      (e: unknown) =>
        e instanceof LockTimeoutError &&
        e.waitedMs === 0 &&
        e.message === 'could not acquire locks in time: deployment:proj:prod',
    );
    assert.deepEqual(sleeps, []);
    assert.equal(now(), T0);
  });

  it('no conflict → no waiting even with a generous timeout', () => {
    const { mgr, sleeps, now } = fakeManager();
    const grants = mgr.acquireAll(
      [
        { kind: 'file', key: '/ws/a.ts', owner: 'run-A', ttlMs: 60_000 },
        { kind: 'task', key: 'TASK-1', owner: 'run-A', ttlMs: 60_000 },
      ],
      { timeoutMs: 5_000 },
    );
    assert.equal(grants.length, 2);
    assert.deepEqual(sleeps, []);
    assert.equal(now(), T0);
  });
});

describe('ResourceLockManager — acquire() shares the wait semantics', () => {
  it('acquire waits for a short TTL to lapse instead of throwing', () => {
    const { mgr, now, sleptTotal } = fakeManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 300);

    const grant = mgr.acquire('deployment', 'proj:prod', 'run-B', 60_000, 5_000);
    assert.equal(grant.owner, 'run-B');
    assert.equal(now() - T0, 300);
    assert.equal(sleptTotal(), 300);
    assert.equal(grant.acquiredAt, new Date(T0 + 300).toISOString());
  });

  it('acquire gives up at its timeout and reports the waited duration', () => {
    const { mgr } = fakeManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 60_000);

    assert.throws(
      () => mgr.acquire('deployment', 'proj:prod', 'run-B', 60_000, 200),
      (e: unknown) =>
        e instanceof LockTimeoutError &&
        e.waitedMs === 200 &&
        e.keys.length === 1 &&
        e.keys[0] === 'deployment:proj:prod',
    );
    assert.equal(mgr.holder('deployment', 'proj:prod')?.owner, 'run-A');
  });
});

describe('ResourceLockManager — real clock, default Atomics.wait sleep', () => {
  it('acquireAll waits for a real short-lived lock to expire', () => {
    const mgr = new ResourceLockManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 120);
    const t0 = Date.now();
    const grants = mgr.acquireAll(
      [{ kind: 'deployment', key: 'proj:prod', owner: 'run-B', ttlMs: 60_000 }],
      { timeoutMs: 2_000 },
    );
    const elapsed = Date.now() - t0;
    assert.equal(grants[0].owner, 'run-B');
    assert.ok(elapsed >= 100, `expected to wait ~120ms, waited ${elapsed}ms`);
    assert.ok(elapsed < 1_500, `wait overshot: ${elapsed}ms`);
  });

  it('acquireAll throws after a real short timeout against a long-lived lock', () => {
    const mgr = new ResourceLockManager();
    mgr.acquire('deployment', 'proj:prod', 'run-A', 5_000);
    const t0 = Date.now();
    let err: unknown;
    try {
      mgr.acquireAll(
        [{ kind: 'deployment', key: 'proj:prod', owner: 'run-B', ttlMs: 60_000 }],
        { timeoutMs: 150 },
      );
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    assert.ok(err instanceof LockTimeoutError);
    assert.ok(err.waitedMs >= 130, `waitedMs too small: ${err.waitedMs}`);
    assert.ok(elapsed >= 130 && elapsed < 1_500, `elapsed out of bounds: ${elapsed}ms`);
    assert.equal(mgr.holder('deployment', 'proj:prod')?.owner, 'run-A');
  });
});
