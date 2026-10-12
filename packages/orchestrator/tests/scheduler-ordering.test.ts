/**
 * §21.1 queueing factors + authority rejection (G-32) and §21.2 fairness
 * & preemption: aging, P0 safe-point preemption with migration
 * protection, reserved Monitor/Recovery capacity (G-33).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidAuthorityError,
  Scheduler,
  SchedulableTask,
} from '../src/index';

function task(over: Partial<SchedulableTask> = {}): SchedulableTask {
  return { id: 't', priority: 'P2', dependsOn: [], ...over };
}

function mutableClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('§21.1 authority is rejected before queueing (G-32)', () => {
  it('rejects a blank principal', () => {
    const s = new Scheduler();
    assert.throws(
      () => s.enqueue(task({ authority: { principal: '  ' } })),
      (e: unknown) => e instanceof InvalidAuthorityError && /non-empty/.test(e.reason),
    );
    assert.deepEqual(s.nextBatch(), []);
  });

  it('rejects when the validator rejects, and logs the rejection', () => {
    const s = new Scheduler({
      authorityValidator: (t) =>
        t.authority?.principal === 'rogue' ? 'principal has no dispatch authority' : null,
    });
    assert.throws(
      () => s.enqueue(task({ authority: { principal: 'rogue' } })),
      InvalidAuthorityError,
    );
    const log = s.decisionLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]!.kind, 'enqueue-rejected');
  });

  it('requireAuthority rejects tasks with no principal', () => {
    const s = new Scheduler({ requireAuthority: true });
    assert.throws(() => s.enqueue(task()), InvalidAuthorityError);
    s.enqueue(task({ authority: { principal: 'cto' } }));
    assert.deepEqual(s.nextBatch(), ['t']);
  });
});

describe('§21.1 multi-factor queue ordering (G-32)', () => {
  it('severity breaks priority ties, higher first', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'mild', severity: 1 }));
    s.enqueue(task({ id: 'severe', severity: 9 }));
    s.enqueue(task({ id: 'mid', severity: 5 }));
    assert.deepEqual(s.nextBatch(), ['severe', 'mid', 'mild']);
  });

  it('earlier SLA deadlines schedule first', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'late', slaDeadline: 9_000 }));
    s.enqueue(task({ id: 'early', slaDeadline: 1_000 }));
    s.enqueue(task({ id: 'none' }));
    assert.deepEqual(s.nextBatch(), ['early', 'late', 'none']);
  });

  it('longer critical paths schedule first', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'leaf', criticalPathLength: 1 }));
    s.enqueue(task({ id: 'trunk', criticalPathLength: 6 }));
    assert.deepEqual(s.nextBatch(), ['trunk', 'leaf']);
  });

  it('higher risk schedules first (documented local policy)', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'safe', risk: 1 }));
    s.enqueue(task({ id: 'risky', risk: 8 }));
    assert.deepEqual(s.nextBatch(), ['risky', 'safe']);
  });

  it('used capacity: the less-loaded pinned agent goes first', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'running', agentId: 'a1' }));
    s.startOn('running', 'a1');
    s.enqueue(task({ id: 'for-a1', agentId: 'a1' }));
    s.enqueue(task({ id: 'for-a2', agentId: 'a2' }));
    assert.deepEqual(s.nextBatch(), ['for-a2', 'for-a1']);
  });

  it('fairness: the principal with fewer running tasks goes first', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'a-running', authority: { principal: 'boss-a' } }));
    s.start('a-running');
    s.enqueue(task({ id: 'a-next', authority: { principal: 'boss-a' } }));
    s.enqueue(task({ id: 'b-next', authority: { principal: 'boss-b' } }));
    assert.deepEqual(s.nextBatch(), ['b-next', 'a-next']);
  });

  it('FIFO remains the final tiebreak', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue(task({ id: 'first' }));
    s.enqueue(task({ id: 'second' }));
    assert.deepEqual(s.nextBatch(), ['first', 'second']);
  });
});

describe('§21.2 aging (G-33)', () => {
  it('waiting raises effective priority up to the configured cap', () => {
    const clock = mutableClock(0);
    const s = new Scheduler({
      concurrencyLimit: 1,
      clock,
      aging: { intervalMs: 1_000, maxBoostLevels: 2 },
    });
    s.enqueue(task({ id: 'old-p3', priority: 'P3' }));
    clock.advance(2_500); // two full intervals waited → boost 2 → P1 level
    s.enqueue(task({ id: 'fresh-p1', priority: 'P1' }));
    assert.deepEqual(s.nextBatch(), ['old-p3']);
  });

  it('aging never lifts a task above the boost cap', () => {
    const clock = mutableClock(0);
    const s = new Scheduler({
      concurrencyLimit: 1,
      clock,
      aging: { intervalMs: 1_000, maxBoostLevels: 1 },
    });
    s.enqueue(task({ id: 'old-p4', priority: 'P4' }));
    clock.advance(60_000);
    s.enqueue(task({ id: 'fresh-p1', priority: 'P1' }));
    // Boost capped at 1 → effective P3, still behind the genuine P1.
    assert.deepEqual(s.nextBatch(), ['fresh-p1']);
  });

  it('without the aging option, waiting changes nothing', () => {
    const clock = mutableClock(0);
    const s = new Scheduler({ concurrencyLimit: 1, clock });
    s.enqueue(task({ id: 'old-p3', priority: 'P3' }));
    clock.advance(60_000);
    s.enqueue(task({ id: 'fresh-p1', priority: 'P1' }));
    assert.deepEqual(s.nextBatch(), ['fresh-p1']);
  });
});

describe('§21.2 reserved Monitor/Recovery capacity (G-33)', () => {
  it('development is refused when only reserved slots remain; monitor work still starts', () => {
    const s = new Scheduler({ concurrencyLimit: 3, reservedSlots: 1 });
    s.enqueue(task({ id: 'dev-1' }));
    s.enqueue(task({ id: 'dev-2' }));
    s.enqueue(task({ id: 'dev-3' }));
    const ev = s.evaluateBatch();
    assert.deepEqual(ev.selected, ['dev-1', 'dev-2']);
    assert.equal(ev.blocked.length, 1);
    assert.equal(ev.blocked[0]!.taskId, 'dev-3');
    assert.equal(ev.blocked[0]!.failures[0]!.constraint, 'reservedCapacity');

    // Actually start the two selected dev tasks: now the development
    // pool is full and only the reserved slot remains.
    s.start('dev-1');
    s.start('dev-2');
    s.enqueue(task({ id: 'watchdog', lane: 'monitor' }));
    const ev2 = s.evaluateBatch();
    assert.ok(ev2.selected.includes('watchdog'));
    assert.ok(!ev2.selected.includes('dev-3'));
    assert.equal(
      ev2.blocked.find((b) => b.taskId === 'dev-3')?.failures[0]!.constraint,
      'reservedCapacity',
    );
  });

  it('with no reserve configured, all slots serve development (back-compat)', () => {
    const s = new Scheduler({ concurrencyLimit: 2 });
    s.enqueue(task({ id: 'a' }));
    s.enqueue(task({ id: 'b' }));
    assert.deepEqual(s.nextBatch(), ['a', 'b']);
  });
});

describe('§21.2 P0 safe-point preemption (G-33)', () => {
  function busyScheduler(over: Partial<SchedulableTask> = {}) {
    const clock = mutableClock(0);
    const s = new Scheduler({ concurrencyLimit: 1, clock });
    s.enqueue(task({ id: 'dev', priority: 'P2', ...over }));
    s.start('dev');
    return { s, clock };
  }

  it('no preemption while a slot is free or the victim is not at a safe point', () => {
    const { s } = busyScheduler();
    s.enqueue(task({ id: 'incident', priority: 'P0' }));
    assert.equal(s.evaluatePreemption(), null); // dev not at a safe point
    s.markSafePoint('dev');
    const d = s.evaluatePreemption();
    assert.equal(d?.preemptTaskId, 'dev');
    assert.equal(d?.forTaskId, 'incident');
  });

  it('applyPreemption requeues the victim (not done) and frees the slot for the P0', () => {
    const { s } = busyScheduler();
    s.enqueue(task({ id: 'incident', priority: 'P0' }));
    s.markSafePoint('dev');
    const d = s.evaluatePreemption()!;
    s.applyPreemption(d);
    assert.deepEqual(s.doneIds(), []);
    assert.deepEqual(s.runningIds(), []);
    // Incident takes the freed slot; the victim waits, marked preempted
    // in the batch basis.
    const ev = s.evaluateBatch();
    assert.deepEqual(ev.selected, ['incident']);
    s.start('incident');
    s.finish('incident');
    const ev2 = s.evaluateBatch();
    assert.deepEqual(ev2.selected, ['dev']);
    assert.equal(ev2.basis['dev']!.preempted, true);
    const log = s.decisionLog();
    assert.ok(log.some((e) => e.kind === 'preemption-applied'));
  });

  it('a task inside a protected transaction is never preempted (§21.2)', () => {
    const { s } = busyScheduler({ protectedFromPreemption: true });
    s.enqueue(task({ id: 'incident', priority: 'P0' }));
    s.markSafePoint('dev');
    assert.equal(s.evaluatePreemption(), null);
  });

  it('migration protection: a resumed victim cannot be preempted again inside the window', () => {
    const clock = mutableClock(0);
    const s = new Scheduler({
      concurrencyLimit: 1,
      clock,
      preemptionProtectionMs: 10_000,
    });
    s.enqueue(task({ id: 'dev', priority: 'P2' }));
    s.start('dev');
    s.markSafePoint('dev');
    s.enqueue(task({ id: 'incident-1', priority: 'P0' }));
    s.applyPreemption(s.evaluatePreemption()!);
    s.start('incident-1');
    s.finish('incident-1');
    // Victim resumes; a second P0 arrives within the protection window.
    s.start('dev');
    s.markSafePoint('dev');
    s.enqueue(task({ id: 'incident-2', priority: 'P0' }));
    assert.equal(s.evaluatePreemption(), null);
    // After the window passes, it is a normal preemptible task again.
    clock.advance(10_001);
    assert.equal(s.evaluatePreemption()?.preemptTaskId, 'dev');
  });

  it('applyPreemption refuses a victim that is not at a safe point', () => {
    const { s } = busyScheduler();
    assert.throws(
      () => s.applyPreemption({ preemptTaskId: 'dev', forTaskId: 'x', reason: 'manual' }),
      /not at a safe point/,
    );
  });
});
