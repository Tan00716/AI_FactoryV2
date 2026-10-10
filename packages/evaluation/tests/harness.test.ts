/** @ai-factory/evaluation — independent Eval Harness (spec §45.3). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvalHarness,
  HarnessError,
  HoldoutLeakError,
  runEvaluation,
  type AttemptOutcome,
  type EvalSample,
} from '../src/index';

function sample(over: Partial<EvalSample> = {}): EvalSample {
  return {
    sampleId: 'sample-1',
    content: 'trace…',
    split: 'train',
    source: 'task-run-1',
    ...over,
  };
}

function ok(outcome: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    success: true,
    score: 0.9,
    cost: { durationMs: 100, tokensUsed: 10 },
    sideEffects: [],
    ...outcome,
  };
}

function harness(): EvalHarness {
  const h = new EvalHarness({ now: () => 1 });
  h.registerScorer('quality', (s) => (s.content.includes('trace') ? 0.9 : 0.2));
  h.seal();
  return h;
}

describe('EvalHarness — independent scoring boundary [§45.3]', () => {
  it('scores samples through the read-only view', () => {
    const h = harness();
    const ro = h.readOnly();
    assert.equal(ro.score(sample()), 0.9);
    assert.deepEqual(ro.policy(), { passThreshold: 0.6, scorerNames: ['quality'] });
    assert.ok(h.isSealed());
  });

  it('TAMPER: registering a scorer after seal is rejected', () => {
    const h = harness();
    assert.throws(
      () => h.registerScorer('cheat', () => 1.0),
      (err: unknown) => {
        assert.ok(err instanceof HarnessError);
        assert.equal(err.code, 'HARNESS_SEALED');
        return true;
      },
    );
    // The policy the executor sees is unchanged.
    assert.deepEqual(h.readOnly().policy().scorerNames, ['quality']);
    assert.equal(h.readOnly().score(sample()), 0.9);
  });

  it('TAMPER: the frozen policy object cannot be rewritten', () => {
    const h = harness();
    // Direct internal tamper attempt: the sealed policy is frozen.
    assert.throws(
      () => {
        (h as unknown as { policy: { passThreshold: number } }).policy.passThreshold = 0;
      },
      TypeError,
      'frozen policy rejects writes',
    );
    assert.equal(h.readOnly().policy().passThreshold, 0.6);
    assert.equal(h.readOnly().score(sample()), 0.9);
    // policy() hands out a defensive copy — mutating the copy changes nothing.
    const copy = h.readOnly().policy();
    copy.passThreshold = 0;
    copy.scorerNames.push('cheat');
    assert.equal(h.readOnly().policy().passThreshold, 0.6);
    assert.deepEqual(h.readOnly().policy().scorerNames, ['quality']);
  });
});

describe('runEvaluation — train/holdout separation [§45.3]', () => {
  it('refuses holdout samples for training_selection', async () => {
    const h = harness();
    await assert.rejects(
      () =>
        runEvaluation(
          [sample({ sampleId: 'h1', split: 'holdout' }), sample({ sampleId: 't1', split: 'train' })],
          { harness: h, purpose: 'training_selection', execute: () => ok() },
        ),
      (err: unknown) => {
        assert.ok(err instanceof HoldoutLeakError);
        assert.equal(err.code, 'HOLDOUT_LEAK');
        assert.match((err as Error).message, /h1/);
        return true;
      },
    );
  });

  it('train-only samples are fine for training_selection', async () => {
    const h = harness();
    const { runs, summary } = await runEvaluation(
      [sample({ sampleId: 't1' }), sample({ sampleId: 't2' })],
      { harness: h, purpose: 'training_selection', execute: () => ok() },
    );
    assert.equal(runs.length, 2);
    assert.equal(summary.passed, 2);
  });

  it('holdout samples ARE allowed for benchmark purpose', async () => {
    const h = harness();
    const { runs } = await runEvaluation(
      [sample({ sampleId: 'h1', split: 'holdout' })],
      { harness: h, purpose: 'benchmark', execute: () => ok() },
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].purpose, 'benchmark');
  });
});

describe('runEvaluation — full attempt retention [§45.3]', () => {
  it('records ALL attempts: costs, failures and side effects, not just the best', async () => {
    const h = harness();
    const { runs, summary } = await runEvaluation([sample()], {
      harness: h,
      purpose: 'benchmark',
      execute: () => [
        ok({ success: false, score: 0.2, failureReason: 'timeout after 30s', cost: { durationMs: 30000, tokensUsed: 500 }, sideEffects: ['tmp file written'] }),
        ok({ success: false, score: 0.4, failureReason: 'assertion failed', cost: { durationMs: 200, tokensUsed: 50 }, sideEffects: ['db row touched'] }),
        ok({ success: true, score: 0.95, cost: { durationMs: 150, tokensUsed: 40 } }),
      ],
    });
    const [run] = runs;
    assert.equal(run.attempts.length, 3, 'every attempt kept');
    assert.equal(run.attempts[0].failureReason, 'timeout after 30s');
    assert.deepEqual(run.attempts[0].sideEffects, ['tmp file written']);
    assert.equal(run.attempts[1].failureReason, 'assertion failed');
    assert.equal(run.totalCost.durationMs, 30350);
    assert.equal(run.totalCost.tokensUsed, 590);
    assert.equal(run.bestScore, 0.95, 'best score is informational — attempts are not dropped');
    assert.equal(run.passed, true);
    assert.equal(summary.attempts, 3);
    assert.equal(summary.totalCost.tokensUsed, 590);
  });

  it('a run with only failures records the failure, not a silent pass', async () => {
    const h = harness();
    const { runs } = await runEvaluation([sample()], {
      harness: h,
      purpose: 'benchmark',
      execute: () => ok({ success: false, score: 0.1, failureReason: 'crash', sideEffects: ['coredump'] }),
    });
    assert.equal(runs[0].passed, false);
    assert.equal(runs[0].attempts.length, 1);
    assert.equal(runs[0].attempts[0].failureReason, 'crash');
  });

  it('the harness can score attempts the executor did not score', async () => {
    const h = harness();
    const { runs } = await runEvaluation([sample()], {
      harness: h,
      purpose: 'benchmark',
      execute: (_s, scorer) => {
        // Executor uses the read-only scorer — it cannot rewrite it.
        const s = scorer.score(_s);
        return ok({ success: true, cost: { durationMs: 10, tokensUsed: 5 } , score: s });
      },
    });
    assert.equal(runs[0].bestScore, 0.9);
  });
});
