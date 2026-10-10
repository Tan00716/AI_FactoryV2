import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, LoopStagnation } from '../src/index';

const BUDGETS = { maxSteps: 60, timeMs: 60_000, maxRetries: 20 };

describe('evidence-aware stagnation (§25)', () => {
  it('legacy behavior unchanged when no evidence callback is given', async () => {
    const loop = new AgentLoop({ budgets: BUDGETS, stagnationLimit: 3 });
    await assert.rejects(
      loop.run(async () => ({ ok: false, error: 'boom', errorSignature: 'sig-a' })),
      LoopStagnation,
    );
  });

  it('new evidence resets the stagnation counter for a repeating signature', async () => {
    // Every failure reports new diagnostics → the counter never reaches the
    // limit → the loop must NOT stagnate (it ends on the step budget instead).
    const limited = new AgentLoop({
      budgets: { maxSteps: 8, timeMs: 60_000, maxRetries: 20 },
      stagnationLimit: 100,
      evidenceAddedSinceLastFailure: () => true,
    });
    const { BudgetExceeded } = await import('../src/index');
    await assert.rejects(
      limited.run(async () => ({ ok: false, error: 'boom', errorSignature: 'sig-a' })),
      BudgetExceeded,
      'with constant new evidence the loop must not stagnate',
    );
  });

  it('SUBMIT is accepted as a terminal decision', async () => {
    const loop = new AgentLoop({ budgets: BUDGETS });
    const out = await loop.run(async (phase) =>
      phase === 'EVALUATE'
        ? { ok: true, decision: 'SUBMIT' }
        : { ok: true },
    );
    assert.equal(out.decision, 'COMPLETE');
  });
});
