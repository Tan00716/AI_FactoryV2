/**
 * Tests for the scheduler (spec §93): dependency gating, priority
 * ordering, concurrency limits, and per-agent workload tracking.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/index';

function chainScheduler(): Scheduler {
  const s = new Scheduler({ concurrencyLimit: 2 });
  s.enqueue({ id: 'investigate', priority: 'P1', dependsOn: [] });
  s.enqueue({ id: 'reproduce', priority: 'P1', dependsOn: ['investigate'] });
  s.enqueue({ id: 'fix', priority: 'P1', dependsOn: ['reproduce'] });
  s.enqueue({ id: 'tests', priority: 'P2', dependsOn: ['fix'] });
  s.enqueue({ id: 'regression', priority: 'P2', dependsOn: ['tests'] });
  return s;
}

describe('Scheduler', () => {
  it('gates on dependencies: blocked tasks are skipped', () => {
    const s = chainScheduler();
    assert.deepEqual(s.nextBatch([]), ['investigate']);
    s.start('investigate');
    // 'reproduce' depends on 'investigate' which is running, not done → skip.
    assert.deepEqual(s.nextBatch(['investigate']), []);
    s.finish('investigate');
    assert.deepEqual(s.nextBatch([]), ['reproduce']);
  });

  it('respects the concurrency limit', () => {
    const s = new Scheduler({ concurrencyLimit: 2 });
    s.enqueue({ id: 'a', priority: 'P2', dependsOn: [] });
    s.enqueue({ id: 'b', priority: 'P2', dependsOn: [] });
    s.enqueue({ id: 'c', priority: 'P2', dependsOn: [] });
    assert.deepEqual(s.nextBatch([]), ['a', 'b']);
    // One slot taken externally → only one more.
    assert.deepEqual(s.nextBatch(['a']), ['b']);
    // No slots left.
    assert.deepEqual(s.nextBatch(['a', 'b']), []);
  });

  it('orders by priority P0 → P3, FIFO within a priority', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue({ id: 'enhancement', priority: 'P3', dependsOn: [] });
    s.enqueue({ id: 'normal', priority: 'P2', dependsOn: [] });
    s.enqueue({ id: 'incident', priority: 'P0', dependsOn: [] });
    s.enqueue({ id: 'critical', priority: 'P1', dependsOn: [] });
    s.enqueue({ id: 'normal2', priority: 'P2', dependsOn: [] });
    assert.deepEqual(s.nextBatch([]), ['incident', 'critical', 'normal', 'normal2', 'enhancement']);
  });

  it('P4 Research sorts after P3 (§21.1 five levels)', () => {
    const s = new Scheduler({ concurrencyLimit: 10 });
    s.enqueue({ id: 'research', priority: 'P4', dependsOn: [] });
    s.enqueue({ id: 'enhancement', priority: 'P3', dependsOn: [] });
    s.enqueue({ id: 'incident', priority: 'P0', dependsOn: [] });
    assert.deepEqual(s.nextBatch([]), ['incident', 'enhancement', 'research']);
  });

  it('drives a full dependency chain to completion', () => {
    const s = chainScheduler();
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      const batch = s.nextBatch();
      assert.equal(batch.length, 1);
      order.push(batch[0]!);
      s.start(batch[0]!);
      s.finish(batch[0]!);
    }
    assert.deepEqual(order, ['investigate', 'reproduce', 'fix', 'tests', 'regression']);
    assert.deepEqual(s.nextBatch([]), []);
  });

  it('tracks per-agent workload and releases it on finish', () => {
    const s = new Scheduler({ concurrencyLimit: 4 });
    s.enqueue({ id: 't1', priority: 'P2', dependsOn: [] });
    s.enqueue({ id: 't2', priority: 'P2', dependsOn: [] });
    assert.deepEqual(s.getWorkload('agent-1'), { agentId: 'agent-1', activeCount: 0 });
    s.startOn('t1', 'agent-1');
    s.startOn('t2', 'agent-1');
    assert.equal(s.getWorkload('agent-1').activeCount, 2);
    s.finish('t1');
    assert.equal(s.getWorkload('agent-1').activeCount, 1);
    s.finish('t2');
    assert.equal(s.getWorkload('agent-1').activeCount, 0);
  });

  it('dequeue removes a task from future batches', () => {
    const s = new Scheduler();
    s.enqueue({ id: 'a', priority: 'P2', dependsOn: [] });
    assert.equal(s.dequeue('a'), true);
    assert.deepEqual(s.nextBatch([]), []);
  });
});
