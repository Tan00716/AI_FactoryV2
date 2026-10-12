/**
 * §21.4 budget lifecycle (G-35) + block conditions (G-36):
 *  - money/CPU/RAM dimensions exist and are consumable;
 *  - atomic reserve → charge → settle/release with no oversell;
 *  - unknown amounts counted separately, never fabricated into usage;
 *  - overruns carry the §21.4 block condition (BUDGET_BLOCK for spend
 *    dimensions, RESOURCE_BLOCK for capacity dimensions) on both the
 *    thrown error and the onExceed event.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError,
  BudgetExceededEvent,
  BudgetTracker,
  blockConditionForDimension,
} from '../src/index';

describe('§21.4 dimensions (G-35)', () => {
  it('consumes the new money/CPU/RAM dimensions', () => {
    const tr = new BudgetTracker();
    tr.consume('t1', { moneyMinor: 250, cpuMs: 5_000, memoryBytes: 1024 });
    assert.equal(tr.usage('t1').moneyMinor, 250);
    assert.equal(tr.usage('t1').cpuMs, 5_000);
    assert.equal(tr.usage('t1').memoryBytes, 1024);
  });

  it('maps dimensions to §21.4 block conditions', () => {
    assert.equal(blockConditionForDimension('moneyMinor'), 'BUDGET_BLOCK');
    assert.equal(blockConditionForDimension('tokens'), 'BUDGET_BLOCK');
    assert.equal(blockConditionForDimension('cpuMs'), 'RESOURCE_BLOCK');
    assert.equal(blockConditionForDimension('memoryBytes'), 'RESOURCE_BLOCK');
    assert.equal(blockConditionForDimension('processes'), 'RESOURCE_BLOCK');
    assert.equal(blockConditionForDimension('maxConcurrentAgents'), 'RESOURCE_BLOCK');
  });

  it('stamps the block condition on the error and the onExceed event (G-36)', () => {
    const events: BudgetExceededEvent[] = [];
    const tr = new BudgetTracker({ onExceed: (e) => events.push(e) });
    tr.setBudget('t1', { moneyMinor: 10, cpuMs: 10 });
    assert.throws(
      () => tr.consume('t1', { moneyMinor: 11 }),
      (err: unknown) =>
        err instanceof BudgetExceededError && err.condition === 'BUDGET_BLOCK',
    );
    assert.throws(
      () => tr.consume('t1', { cpuMs: 11 }),
      (err: unknown) =>
        err instanceof BudgetExceededError && err.condition === 'RESOURCE_BLOCK',
    );
    assert.deepEqual(
      events.map((e) => e.condition),
      ['BUDGET_BLOCK', 'RESOURCE_BLOCK'],
    );
  });
});

describe('§21.4 reserve → charge → settle/release (G-35)', () => {
  it('a hold reduces what new work may claim, without counting as usage', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100 });
    const r = tr.reserve('t1', { tokens: 40 });
    assert.equal(r.status, 'OPEN');
    assert.equal(tr.held('t1', 'tokens'), 40);
    assert.equal(tr.usage('t1').tokens, 0);
    assert.equal(tr.check('t1').tokens, 60);
    // Plain consume respects the hold: 61 would oversell.
    assert.throws(() => tr.consume('t1', { tokens: 61 }), BudgetExceededError);
    tr.consume('t1', { tokens: 60 });
    assert.equal(tr.check('t1').tokens, 0);
  });

  it('reserve is all-or-nothing across dimensions', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100, toolCalls: 5 });
    assert.throws(
      () => tr.reserve('t1', { tokens: 50, toolCalls: 6 }),
      BudgetExceededError,
    );
    // The fitting dimension was NOT held either.
    assert.equal(tr.held('t1', 'tokens'), 0);
    assert.deepEqual(tr.listReservations('t1'), []);
  });

  it('concurrent reservations cannot oversell the budget', async () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100 });
    // Ten interleaved async attempts of 30 each: exactly three fit (90);
    // the rest are rejected whole, and total held never exceeds 100.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await Promise.resolve(); // interleave like real async subtasks
        try {
          tr.reserve('t1', { tokens: 30 });
          return 'held';
        } catch (e) {
          assert.ok(e instanceof BudgetExceededError);
          return 'rejected';
        }
      }),
    );
    assert.equal(attempts.filter((a) => a === 'held').length, 3);
    assert.equal(attempts.filter((a) => a === 'rejected').length, 7);
    assert.equal(tr.held('t1', 'tokens'), 90);
    assert.ok(tr.held('t1', 'tokens') <= 100);
  });

  it('charge converts hold into usage and cannot exceed the hold', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100 });
    const r = tr.reserve('t1', { tokens: 50 });
    const after = tr.charge(r.id, { tokens: 20 });
    assert.deepEqual(after.charged, { tokens: 20 });
    assert.equal(tr.usage('t1').tokens, 20);
    assert.equal(tr.held('t1', 'tokens'), 30);
    assert.throws(() => tr.charge(r.id, { tokens: 31 }), /exceeds reservation hold/);
    // Failed charge changed nothing.
    assert.equal(tr.usage('t1').tokens, 20);
    assert.equal(tr.held('t1', 'tokens'), 30);
  });

  it('settle charges final actuals and frees the remaining hold', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100 });
    const r = tr.reserve('t1', { tokens: 50 });
    tr.charge(r.id, { tokens: 20 });
    const settled = tr.settle(r.id, { tokens: 5 });
    assert.equal(settled.status, 'SETTLED');
    assert.equal(tr.usage('t1').tokens, 25);
    assert.equal(tr.held('t1', 'tokens'), 0);
    assert.equal(tr.check('t1').tokens, 75);
  });

  it('release frees the uncharged hold; already-charged usage stays', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { tokens: 100 });
    const r = tr.reserve('t1', { tokens: 50 });
    tr.charge(r.id, { tokens: 10 });
    const released = tr.release(r.id);
    assert.equal(released.status, 'RELEASED');
    assert.equal(tr.usage('t1').tokens, 10);
    assert.equal(tr.check('t1').tokens, 90);
  });

  it('closed reservations reject further lifecycle operations', () => {
    const tr = new BudgetTracker();
    const r = tr.reserve('t1', { tokens: 10 });
    tr.release(r.id);
    assert.throws(() => tr.charge(r.id, { tokens: 1 }), /already RELEASED/);
    assert.throws(() => tr.settle(r.id), /already RELEASED/);
    assert.throws(() => tr.release(r.id), /already RELEASED/);
    assert.throws(() => tr.charge('no-such-id', { tokens: 1 }), /not found/);
  });

  it('reserve validates its amounts', () => {
    const tr = new BudgetTracker();
    assert.throws(() => tr.reserve('t1', {}), /at least one dimension/);
    assert.throws(() => tr.reserve('t1', { tokens: 0 }), /positive number/);
    assert.throws(() => tr.reserve('t1', { tokens: -5 }), /positive number/);
  });

  it('reservations work on the §21.4 money dimension', () => {
    const tr = new BudgetTracker();
    tr.setBudget('t1', { moneyMinor: 1_000 });
    const r = tr.reserve('t1', { moneyMinor: 400 });
    tr.settle(r.id, { moneyMinor: 350 });
    assert.equal(tr.usage('t1').moneyMinor, 350);
    assert.equal(tr.check('t1').moneyMinor, 650);
  });
});

describe('§21.4/§27.1 unknown amounts (G-35)', () => {
  it('unknown amounts are counted separately and never enter usage', () => {
    const tr = new BudgetTracker();
    tr.consume('t1', { tokens: 10 });
    assert.equal(tr.recordUnknown('t1', 'moneyMinor'), 1);
    assert.equal(tr.recordUnknown('t1', 'moneyMinor'), 2);
    assert.equal(tr.recordUnknown('t1', 'tokens'), 1);
    const unknown = tr.unknownUsage('t1');
    assert.equal(unknown.moneyMinor, 2);
    assert.equal(unknown.tokens, 1);
    // Usage shows only the measurable facts — no fabricated money figure.
    assert.equal(tr.usage('t1').moneyMinor, 0);
    assert.equal(tr.usage('t1').tokens, 10);
    assert.equal(tr.check('t1').moneyMinor, tr.getBudget('t1').moneyMinor);
  });
});
