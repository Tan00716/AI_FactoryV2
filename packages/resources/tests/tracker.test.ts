import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError,
  BudgetTracker,
  BudgetExceededEvent,
  ConsumableDimension,
  DEFAULT_TASK_BUDGET,
} from '../src/index';

function mutableClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('BudgetTracker', () => {
  it('consumes within budget without error', () => {
    const tr = new BudgetTracker();
    tr.consume('t1', { tokens: 100, toolCalls: 5 });
    const remaining = tr.check('t1');
    assert.equal(remaining.tokens, DEFAULT_TASK_BUDGET.tokens - 100);
    assert.equal(remaining.toolCalls, DEFAULT_TASK_BUDGET.toolCalls - 5);
  });

  it('accumulates consumption across multiple consume() calls', () => {
    const tr = new BudgetTracker();
    tr.consume('t1', { tokens: 100 });
    tr.consume('t1', { tokens: 150 });
    assert.equal(tr.usage('t1').tokens, 250);
    assert.equal(tr.check('t1').tokens, DEFAULT_TASK_BUDGET.tokens - 250);
  });

  it('throws BudgetExceededError with dimension+taskId when tokens are exhausted', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 10 });
    tr.consume('t1', { tokens: 10 });
    assert.throws(
      () => tr.consume('t1', { tokens: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.equal(err.name, 'BudgetExceededError');
        assert.equal(err.dimension, 'tokens');
        assert.equal(err.taskId, 't1');
        return true;
      },
    );
  });

  const exhaustionCases: Array<[ConsumableDimension | 'timeMs', Record<string, number>]> = [
    ['toolCalls', { toolCalls: DEFAULT_TASK_BUDGET.toolCalls }],
    ['retries', { retries: DEFAULT_TASK_BUDGET.retries }],
    ['storageBytes', { storageBytes: DEFAULT_TASK_BUDGET.storageBytes }],
    ['processes', { processes: DEFAULT_TASK_BUDGET.processes }],
  ];
  for (const [dimension, fullUsage] of exhaustionCases) {
    it(`exhausts the ${dimension} dimension and rejects`, () => {
      const tr = new BudgetTracker();
      tr.consume('t1', fullUsage as Partial<Record<ConsumableDimension, number>>);
      assert.equal(tr.check('t1')[dimension as ConsumableDimension], 0);
      assert.throws(
        () => tr.consume('t1', fullUsage as Partial<Record<ConsumableDimension, number>>),
        (err: unknown) => err instanceof BudgetExceededError && err.dimension === dimension,
      );
    });
  }

  it('exhausts the timeMs dimension via elapsed wall-clock time', () => {
    const clock = mutableClock(1000);
    const tr = new BudgetTracker({ clock });
    tr.setBudget('t1', { timeMs: 5_000 });
    tr.start('t1');
    clock.advance(6_000); // 6s elapsed > 5s budget
    assert.throws(
      () => tr.consume('t1', { tokens: 1 }),
      (err: unknown) => err instanceof BudgetExceededError && err.dimension === 'timeMs',
    );
  });

  it('fires the onExceed hook with full event details before throwing', () => {
    const events: BudgetExceededEvent[] = [];
    const tr = new BudgetTracker({ onExceed: (e) => events.push(e) });
    tr.setBudget('t1', { tokens: 10 });
    assert.throws(() => tr.consume('t1', { tokens: 11 }), BudgetExceededError);
    assert.equal(events.length, 1);
    assert.deepEqual(
      { taskId: events[0]!.taskId, dimension: events[0]!.dimension, requested: events[0]!.requested },
      { taskId: 't1', dimension: 'tokens', requested: 11 },
    );
  });

  it('does not debit the dimension when the consume is rejected', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 10 });
    tr.consume('t1', { tokens: 6 });
    assert.throws(() => tr.consume('t1', { tokens: 5 }), BudgetExceededError);
    assert.equal(tr.usage('t1').tokens, 6);
  });

  it('requestIncrease returns a pending record; approval raises the budget', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 10 });
    const req = tr.requestIncrease('t1', 'tokens', 100);
    assert.equal(req.status, 'pending');
    assert.equal(tr.pendingIncreases('t1').length, 1);
    const resolved = tr.resolveIncrease(req.id, true);
    assert.equal(resolved.status, 'approved');
    assert.equal(tr.check('t1').tokens, 110);
    // Consume up to the new limit now works.
    tr.consume('t1', { tokens: 110 });
    assert.equal(tr.check('t1').tokens, 0);
  });

  it('a rejected increase leaves the budget unchanged', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 10 });
    const req = tr.requestIncrease('t1', 'tokens', 100);
    tr.resolveIncrease(req.id, false);
    assert.equal(tr.check('t1').tokens, 10);
    assert.equal(tr.pendingIncreases('t1').length, 0);
  });

  it('rejects resolving an unknown or already-resolved increase', () => {
    const tr = new BudgetTracker();
    assert.throws(() => tr.resolveIncrease('nope', true), /not found/);
    const req = tr.requestIncrease('t1', 'tokens', 5);
    tr.resolveIncrease(req.id, true);
    assert.throws(() => tr.resolveIncrease(req.id, true), /already approved/);
  });

  it('recordAgents rejects when maxConcurrentAgents is exceeded', () => {
    const events: BudgetExceededEvent[] = [];
    const tr = new BudgetTracker({ onExceed: (e) => events.push(e) });
    tr.setBudget('t1', { maxConcurrentAgents: 2 });
    tr.recordAgents('t1', 2); // exactly at limit: fine
    assert.throws(
      () => tr.recordAgents('t1', 3),
      (err: unknown) =>
        err instanceof BudgetExceededError && err.dimension === 'maxConcurrentAgents',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.dimension, 'maxConcurrentAgents');
  });

  it('setBudget only overrides the given dimensions', () => {
    const tr = new BudgetTracker();
    const b = tr.setBudget('t1', { tokens: 999 });
    assert.equal(b.tokens, 999);
    assert.equal(b.maxConcurrentAgents, DEFAULT_TASK_BUDGET.maxConcurrentAgents);
    assert.equal(b.retries, DEFAULT_TASK_BUDGET.retries);
  });
});
