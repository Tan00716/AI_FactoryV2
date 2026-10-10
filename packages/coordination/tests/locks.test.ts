/**
 * Tests for task locking — spec §63.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LockEvent, LockKind, LockManager } from '../src/index';

const ALL_KINDS: LockKind[] = [
  'file',
  'resource',
  'task',
  'branch',
  'environment',
  'deployment',
];

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('LockManager — basic acquire/release', () => {
  it('acquires and releases every lock kind', () => {
    for (const kind of ALL_KINDS) {
      const lm = new LockManager();
      const got = lm.acquire(kind, 'k1', 'agent-a', 60_000);
      assert.equal(got.granted, true, `${kind} should grant`);
      assert.ok(got.token);
      assert.equal(got.queued, false);
      assert.equal(lm.isHeldBy(kind, 'k1', 'agent-a'), true);
      assert.equal(lm.release(got.token!), true);
      assert.equal(lm.isHeldBy(kind, 'k1', 'agent-a'), false);
    }
  });

  it('rejects and queues a second holder while locked', () => {
    const lm = new LockManager();
    const first = lm.acquire('file', 'src/x.ts', 'agent-a', 60_000);
    assert.equal(first.granted, true);
    const second = lm.acquire('file', 'src/x.ts', 'agent-b', 60_000);
    assert.equal(second.granted, false);
    assert.equal(second.queued, true);
    assert.equal(second.heldBy, 'agent-a');
    assert.deepEqual(lm.pendingWaiters('file', 'src/x.ts'), ['agent-b']);
    // Unknown token releases nothing.
    assert.equal(lm.release('nope'), false);
  });

  it('auto-grants the first queued waiter on release (FIFO)', () => {
    const lm = new LockManager();
    const t1 = lm.acquire('task', 'T-1', 'agent-a', 60_000).token!;
    lm.acquire('task', 'T-1', 'agent-b', 60_000);
    lm.acquire('task', 'T-1', 'agent-c', 60_000);
    assert.equal(lm.release(t1), true);
    assert.equal(lm.isHeldBy('task', 'T-1', 'agent-b'), true);
    assert.deepEqual(lm.pendingWaiters('task', 'T-1'), ['agent-c']);
  });

  it('lets the same holder re-acquire to refresh the TTL', () => {
    const clock = makeClock();
    const lm = new LockManager({ clock });
    const first = lm.acquire('resource', 'db', 'agent-a', 1000);
    clock.advance(800);
    const again = lm.acquire('resource', 'db', 'agent-a', 1000);
    assert.equal(again.granted, true);
    assert.equal(again.token, first.token);
    clock.advance(900); // would have expired under the original TTL
    assert.equal(lm.isHeldBy('resource', 'db', 'agent-a'), true);
  });
});

describe('LockManager — TTL expiry', () => {
  it('auto-releases an expired lock (injected clock)', () => {
    const clock = makeClock();
    const lm = new LockManager({ clock });
    lm.acquire('branch', 'main', 'agent-a', 1000);
    clock.advance(1001);
    const second = lm.acquire('branch', 'main', 'agent-b', 60_000);
    assert.equal(second.granted, true);
    assert.equal(lm.isHeldBy('branch', 'main', 'agent-b'), true);
  });

  it('grants a queued waiter when the holder TTL expires', () => {
    const clock = makeClock();
    const lm = new LockManager({ clock });
    lm.acquire('environment', 'staging', 'agent-a', 500);
    lm.acquire('environment', 'staging', 'agent-b', 60_000);
    clock.advance(600);
    assert.equal(lm.isHeldBy('environment', 'staging', 'agent-b'), true);
    assert.equal(lm.pendingWaiters('environment', 'staging').length, 0);
  });
});

describe('LockManager — PROD deployment singleton', () => {
  it('allows only one active PROD deployment holder', () => {
    const lm = new LockManager();
    const first = lm.acquire('deployment', 'prod', 'release-bot-1', 300_000);
    assert.equal(first.granted, true);
    const second = lm.acquire('deployment', 'prod', 'release-bot-2', 300_000);
    assert.equal(second.granted, false);
    assert.equal(second.queued, true);
    assert.equal(second.heldBy, 'release-bot-1');
    assert.ok(second.reason?.includes('single active'));
    // The second bot gets the lock after the first releases.
    lm.release(first.token!);
    assert.equal(lm.isHeldBy('deployment', 'prod', 'release-bot-2'), true);
  });

  it('still serializes non-prod deployments per key only', () => {
    const lm = new LockManager();
    const staging = lm.acquire('deployment', 'staging', 'bot-a', 60_000);
    const prod = lm.acquire('deployment', 'prod', 'bot-b', 60_000);
    assert.equal(staging.granted && prod.granted, true);
  });
});

describe('LockManager — audit', () => {
  it('audits acquire, reject, release and expiry', () => {
    const events: LockEvent[] = [];
    const clock = makeClock();
    const lm = new LockManager({ clock, audit: (e) => events.push(e) });

    const got = lm.acquire('file', 'src/x.ts', 'agent-a', 500);
    const denied = lm.acquire('file', 'src/x.ts', 'agent-b', 500);
    assert.equal(denied.granted, false);
    lm.release(got.token!);
    clock.advance(1000);
    // New acquire after sweep of the auto-granted waiter lock:
    lm.acquire('file', 'src/y.ts', 'agent-c', 500);
    clock.advance(1000);
    lm.sweep();

    const types = events.map((e) => e.type);
    assert.ok(types.includes('acquired'), 'expected acquired');
    assert.ok(types.includes('rejected'), 'expected rejected');
    assert.ok(types.includes('released'), 'expected released');
    assert.ok(types.includes('expired'), 'expected expired');
    assert.ok(types.includes('auto_granted'), 'expected auto_granted');
    for (const e of events) {
      assert.equal(e.kind, 'file');
      assert.ok(typeof e.at === 'number');
    }
  });
});
