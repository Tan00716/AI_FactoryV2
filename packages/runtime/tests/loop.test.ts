/**
 * Tests for AgentLoop — spec §24 (state machine) and §25 (loop engineering).
 * Run: node --test dist/tests/loop.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentLoop,
  BadCheckpoint,
  BudgetExceeded,
  Clock,
  LoopPhase,
  LOOP_PHASES,
  LoopStagnation,
  StepFn,
} from '../src/index';

function fakeClock(start = 1_000): Clock & { advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function generousBudgets() {
  return { maxSteps: 100, timeMs: 60_000, maxRetries: 10 };
}

const okEverywhere: StepFn = () => ({ ok: true });

describe('AgentLoop transitions (§24)', () => {
  it('walks OBSERVE → UNDERSTAND → PLAN → ACT → VERIFY → EVALUATE then COMPLETEs', async () => {
    const seen: LoopPhase[] = [];
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    const outcome = await loop.run((phase) => {
      seen.push(phase);
      return { ok: true, note: phase };
    });
    assert.deepEqual(seen, [...LOOP_PHASES]);
    assert.equal(outcome.decision, 'COMPLETE');
    assert.equal(outcome.steps, 6);
    assert.equal(outcome.retries, 0);
    assert.equal(outcome.trace.length, 6);
  });

  it('CONTINUE restarts the cycle at OBSERVE', async () => {
    let evaluates = 0;
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    const outcome = await loop.run((phase) => {
      if (phase === 'EVALUATE') {
        evaluates += 1;
        return { ok: true, decision: evaluates < 2 ? 'CONTINUE' : 'COMPLETE' };
      }
      return { ok: true };
    });
    assert.equal(evaluates, 2);
    assert.equal(outcome.decision, 'COMPLETE');
    assert.equal(outcome.steps, 12);
  });

  it('HANDOFF and ESCALATE are terminal with handoff target recorded', async () => {
    for (const decision of ['HANDOFF', 'ESCALATE'] as const) {
      const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
      const outcome = await loop.run((phase) =>
        phase === 'EVALUATE'
          ? { ok: true, decision, handoffTo: 'qa-lead' }
          : { ok: true },
      );
      assert.equal(outcome.decision, decision);
      assert.equal(outcome.handoffTo, 'qa-lead');
    }
  });

  it('a thrown StepFn counts as a failed phase (then retries)', async () => {
    let calls = 0;
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    const outcome = await loop.run(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { ok: true };
    });
    assert.equal(outcome.decision, 'COMPLETE');
    assert.equal(outcome.retries, 1);
  });
});

describe('budgets (§25)', () => {
  it('throws BudgetExceeded when maxSteps is reached', async () => {
    const loop = new AgentLoop({
      budgets: { maxSteps: 4, timeMs: 60_000, maxRetries: 100 },
      clock: fakeClock(),
    });
    await assert.rejects(
      loop.run(() => ({ ok: true, decision: 'CONTINUE' })),
      (err: unknown) => err instanceof BudgetExceeded && err.code === 'BUDGET_EXCEEDED',
    );
    assert.equal(loop.snapshot.totalSteps, 4);
  });

  it('throws BudgetExceeded when timeMs is exceeded (injectable clock)', async () => {
    const clock = fakeClock();
    const loop = new AgentLoop({
      budgets: { maxSteps: 100, timeMs: 50, maxRetries: 100 },
      clock,
    });
    await assert.rejects(
      loop.run(() => {
        clock.advance(30);
        return { ok: true, decision: 'CONTINUE' };
      }),
      (err: unknown) => err instanceof BudgetExceeded && /timeMs/.test(err.message),
    );
  });

  it('throws BudgetExceeded when maxRetries is exceeded (distinct errors)', async () => {
    let n = 0;
    const loop = new AgentLoop({
      budgets: { maxSteps: 100, timeMs: 60_000, maxRetries: 2 },
      clock: fakeClock(),
    });
    await assert.rejects(
      loop.run(() => {
        n += 1;
        return { ok: false, error: `error ${n}`, errorSignature: `sig-${n}` };
      }),
      (err: unknown) => err instanceof BudgetExceeded && /maxRetries/.test(err.message),
    );
  });
});

describe('stagnation detection (§25)', () => {
  it('same error signature 3 times → LoopStagnation', async () => {
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    await assert.rejects(
      loop.run(() => ({
        ok: false,
        error: '2 tests failed',
        errorSignature: 'unit:2-failed',
      })),
      (err: unknown) =>
        err instanceof LoopStagnation &&
        err.code === 'LOOP_STAGNATION' &&
        err.signature === 'unit:2-failed',
    );
    assert.equal(loop.snapshot.totalSteps, 3);
  });

  it('respects a custom stagnationLimit', async () => {
    const loop = new AgentLoop({
      budgets: generousBudgets(),
      clock: fakeClock(),
      stagnationLimit: 2,
    });
    await assert.rejects(
      loop.run(() => ({ ok: false, error: 'x', errorSignature: 'same' })),
      (err: unknown) => err instanceof LoopStagnation,
    );
    assert.equal(loop.snapshot.totalSteps, 2);
  });

  it('a fully successful cycle resets the stagnation counter', async () => {
    let failures = 0;
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    const outcome = await loop.run((phase) => {
      // Fail VERIFY twice with the same signature, succeed on the third cycle.
      if (phase === 'VERIFY' && failures < 2) {
        failures += 1;
        return { ok: false, error: '2 tests failed', errorSignature: 'unit:2-failed' };
      }
      return { ok: true };
    });
    assert.equal(outcome.decision, 'COMPLETE');
    assert.equal(outcome.retries, 2);
    // 5 steps (fail at VERIFY) + 5 steps (fail at VERIFY) + 6 steps (complete).
    assert.equal(outcome.steps, 16);
  });
});

describe('checkpoint / resume (§25)', () => {
  it('pauses, checkpoints, resumes and completes with continuous budgets', async () => {
    const clock = fakeClock();
    const budgets = generousBudgets();
    const loop1 = new AgentLoop({ budgets, clock });
    const paused = await loop1.run(okEverywhere, { pauseAtStep: 2 });
    assert.equal(paused.decision, 'PAUSED');

    const token = loop1.checkpoint();
    assert.ok(typeof token === 'string' && token.length > 0);

    const loop2 = new AgentLoop({ budgets, clock });
    loop2.resume(token);
    const done = await loop2.run(okEverywhere);
    assert.equal(done.decision, 'COMPLETE');
    // 2 steps before the checkpoint + 4 after = one full 6-phase cycle.
    assert.equal(done.steps, 6);
    assert.equal(loop2.snapshot.totalSteps, 6);
  });

  it('rejects a corrupt checkpoint token', () => {
    const loop = new AgentLoop({ budgets: generousBudgets(), clock: fakeClock() });
    assert.throws(() => loop.resume('not-a-token'), (err: unknown) => err instanceof BadCheckpoint);
  });
});
