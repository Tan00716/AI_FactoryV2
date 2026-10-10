import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffWithJitter,
  BudgetExceeded,
  BudgetTracker,
  PermissionDenied,
  withRetryBudget,
} from '../src/index';

describe('extended budgets (§25)', () => {
  it('tracks model/tool calls and repair loops', () => {
    const t = new BudgetTracker({ maxModelCalls: 2, maxToolCalls: 1, maxRepairLoops: 1 });
    t.consumeModelCall();
    t.consumeModelCall();
    assert.throws(() => t.consumeModelCall(), BudgetExceeded);
    t.consumeToolCall();
    assert.throws(() => t.consumeToolCall(), BudgetExceeded);
    t.consumeRepairLoop();
    assert.throws(() => t.consumeRepairLoop(), BudgetExceeded);
  });

  it('gives up after maxNoProgressSteps without progress', () => {
    const t = new BudgetTracker({ maxNoProgressSteps: 2 });
    t.noteProgress(false);
    t.noteProgress(false);
    assert.throws(() => t.noteProgress(false), BudgetExceeded);
    // progress resets the counter
    const t2 = new BudgetTracker({ maxNoProgressSteps: 1 });
    t2.noteProgress(false);
    t2.noteProgress(true);
    t2.noteProgress(false);
    assert.throws(() => t2.noteProgress(false), BudgetExceeded);
  });

  it('enforces wall time and context caps', () => {
    let now = 1_000;
    const t = new BudgetTracker({ maxWallTimeMs: 500 }, { now: () => now });
    now = 1_600;
    assert.throws(() => t.checkWallTime(), BudgetExceeded);
    assert.throws(() => t.checkContext(200_001), BudgetExceeded);
    t.checkContext(10);
  });
});

describe('jittered backoff (§25)', () => {
  it('stays within [0, min(cap, base*2^attempt)]', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const cap = Math.min(10_000, 100 * 2 ** attempt);
      for (let i = 0; i < 50; i += 1) {
        const w = backoffWithJitter(attempt, 100, 10_000);
        assert.ok(w >= 0 && w <= cap, `attempt ${attempt}: ${w} <= ${cap}`);
      }
    }
  });

  it('is deterministic with an injected rand', () => {
    const a = backoffWithJitter(2, 100, 10_000, () => 0.5);
    const b = backoffWithJitter(2, 100, 10_000, () => 0.5);
    assert.equal(a, b);
    assert.equal(a, 200); // 0.5 * min(10000, 400)
  });
});

describe('withRetryBudget', () => {
  it('retries transient failures and succeeds', async () => {
    let calls = 0;
    const out = await withRetryBudget(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNRESET');
        return 'ok';
      },
      {
        policy: { maxAttempts: 5, baseMs: 10, capMs: 100, totalBudgetMs: 10_000 },
        sleep: async () => {},
        rand: () => 0,
      },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
  });

  it('does not retry permission denials', async () => {
    let calls = 0;
    await assert.rejects(
      withRetryBudget(
        async () => {
          calls += 1;
          throw new PermissionDenied('shell', 'denied');
        },
        {
          policy: { maxAttempts: 5, baseMs: 10, capMs: 100, totalBudgetMs: 10_000 },
          sleep: async () => {},
        },
      ),
      (err: unknown) => (err as { code?: string }).code === 'PERMISSION_DENIED',
    );
    assert.equal(calls, 1);
  });

  it('gives up when the total budget is exhausted', async () => {
    let now = 0;
    await assert.rejects(
      withRetryBudget(
        async () => {
          throw new Error('ECONNRESET');
        },
        {
          policy: { maxAttempts: 10, baseMs: 1_000, capMs: 5_000, totalBudgetMs: 1_500 },
          clock: { now: () => now },
          sleep: async (ms: number) => {
            now += ms;
          },
          rand: () => 1, // worst-case wait
        },
      ),
      BudgetExceeded,
    );
  });
});
