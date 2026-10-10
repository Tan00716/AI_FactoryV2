/**
 * Tests for safe parallel scheduling — spec §61.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parallelHints,
  schedule,
  ScheduleCycleError,
  ScheduleInput,
  UnknownTaskError,
} from '../src/index';

function input(tasks: string[], edges: ScheduleInput['edges'] = []): ScheduleInput {
  return { tasks, edges };
}

describe('schedule — batching', () => {
  it('puts independent tasks in one parallel batch', () => {
    const r = schedule(input(['a', 'b', 'c']));
    assert.deepEqual(r.batches, [['a', 'b', 'c']]);
    assert.deepEqual(r.level, { a: 0, b: 0, c: 0 });
  });

  it('layers a linear depends_on chain one task per batch', () => {
    const r = schedule(
      input(['a', 'b', 'c'], [
        { from: 'b', to: 'a', kind: 'depends_on' },
        { from: 'c', to: 'b', kind: 'depends_on' },
      ]),
    );
    assert.deepEqual(r.batches, [['a'], ['b'], ['c']]);
  });

  it('layers a diamond DAG correctly', () => {
    const r = schedule(
      input(['root', 'left', 'right', 'join'], [
        { from: 'left', to: 'root', kind: 'depends_on' },
        { from: 'right', to: 'root', kind: 'depends_on' },
        { from: 'join', to: 'left', kind: 'depends_on' },
        { from: 'join', to: 'right', kind: 'depends_on' },
      ]),
    );
    assert.deepEqual(r.batches, [['root'], ['left', 'right'], ['join']]);
    assert.equal(r.level['join'], 2);
  });

  it('respects blocked_by and child_of ordering', () => {
    const r = schedule(
      input(['parent', 'child', 'blocker', 'task'], [
        { from: 'child', to: 'parent', kind: 'child_of' },
        { from: 'task', to: 'blocker', kind: 'blocked_by' },
      ]),
    );
    assert.deepEqual(r.batches, [['blocker', 'parent'], ['child', 'task']]);
  });

  it('treats parallel_with and related_to as non-ordering hints', () => {
    const r = schedule(
      input(['a', 'b', 'c'], [
        { from: 'a', to: 'b', kind: 'parallel_with' },
        { from: 'b', to: 'c', kind: 'related_to' },
      ]),
    );
    assert.deepEqual(r.batches, [['a', 'b', 'c']]);
    assert.deepEqual(
      parallelHints([
        { from: 'a', to: 'b', kind: 'parallel_with' },
        { from: 'b', to: 'c', kind: 'related_to' },
      ]),
      [{ a: 'a', b: 'b' }],
    );
  });

  it('keeps a lone parallel_with pair in the same batch', () => {
    const r = schedule(
      input(['x', 'y'], [{ from: 'x', to: 'y', kind: 'parallel_with' }]),
      { maxConcurrency: 2 },
    );
    assert.deepEqual(r.batches, [['x', 'y']]);
  });
});

describe('schedule — errors', () => {
  it('throws ScheduleCycleError naming the cycle', () => {
    assert.throws(
      () =>
        schedule(
          input(['a', 'b', 'c'], [
            { from: 'a', to: 'b', kind: 'depends_on' },
            { from: 'b', to: 'c', kind: 'depends_on' },
            { from: 'c', to: 'a', kind: 'depends_on' },
          ]),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ScheduleCycleError);
        assert.deepEqual([...err.cycle].sort(), ['a', 'b', 'c']);
        return true;
      },
    );
  });

  it('rejects a self-dependency immediately', () => {
    assert.throws(
      () => schedule(input(['a'], [{ from: 'a', to: 'a', kind: 'blocked_by' }])),
      ScheduleCycleError,
    );
  });

  it('rejects edges referencing unknown tasks', () => {
    assert.throws(
      () => schedule(input(['a'], [{ from: 'a', to: 'ghost', kind: 'depends_on' }])),
      UnknownTaskError,
    );
  });

  it('rejects invalid maxConcurrency', () => {
    assert.throws(() => schedule(input(['a']), { maxConcurrency: 0 }), TypeError);
  });
});

describe('schedule — concurrency limits', () => {
  it('chunks a wide batch to maxConcurrency', () => {
    const tasks = ['t1', 't2', 't3', 't4', 't5'];
    const r = schedule(input(tasks), { maxConcurrency: 2 });
    assert.equal(r.batches.length, 3);
    for (const b of r.batches) assert.ok(b.length <= 2);
    assert.deepEqual(r.batches.flat().sort(), tasks);
  });

  it('still honors ordering when chunking', () => {
    const r = schedule(
      input(['a', 'b', 'c', 'd'], [{ from: 'd', to: 'a', kind: 'depends_on' }]),
      { maxConcurrency: 1 },
    );
    assert.deepEqual(r.batches, [['a'], ['b'], ['c'], ['d']]);
  });

  it('enforces per-resource caps inside a batch', () => {
    const r = schedule(input(['a', 'b', 'c']), {
      resourceOf: () => 'db',
      perResourceLimit: { db: 1 },
    });
    assert.deepEqual(r.batches, [['a'], ['b'], ['c']]);
  });

  it('splits only when the resource cap binds', () => {
    const r = schedule(input(['a', 'b', 'c', 'd']), {
      resourceOf: (t) => (t === 'a' || t === 'b' ? 'db' : 'cpu'),
      perResourceLimit: { db: 1 },
      maxConcurrency: 4,
    });
    const flat = r.batches.flat();
    assert.equal(flat.length, 4);
    const dbBatch = r.batches.findIndex((b) => b.includes('a'));
    assert.notEqual(r.batches[dbBatch].indexOf('b') >= 0, true);
  });
});
