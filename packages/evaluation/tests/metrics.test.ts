/**
 * Tests for §57 metric computation: TaskEvidence → EvaluationMetrics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics,
  TaskEvaluationInput,
  weightedScore,
  verdictFor,
} from '../src/index';

function baseEvidence(): TaskEvaluationInput {
  return {
    taskId: 'task-1',
    agentId: 'backend-01',
    summary: 'Implemented the orders endpoint with tests.',
    evidenceIds: ['ev-test-1', 'ev-review-1'],
    success: true,
    tests: { passed: 24, total: 24 },
    regressions: 0,
    reviewRounds: 1,
    reviewRejections: 0,
    fixLoops: 1,
    durationMs: 3_600_000,
    tokensUsed: 45_000,
    toolCalls: 120,
    toolErrors: 0,
    completionClaims: 1,
    falseCompletions: 0,
    deployments: 1,
    rollbacks: 0,
    decisions: 3,
    escalations: 0,
  };
}

describe('computeMetrics', () => {
  it('computes the §57 metrics for a clean successful task', () => {
    const m = computeMetrics(baseEvidence());
    assert.equal(m.taskSuccess, 1);
    assert.equal(m.testPassRate, 1);
    assert.equal(m.regressionRate, 0);
    assert.equal(m.reviewRejectionRate, 0);
    assert.equal(m.loopEfficiency, 1);
    assert.equal(m.durationMs, 3_600_000);
    assert.equal(m.tokenUsage, 45_000);
    assert.equal(m.toolErrorRate, 0);
    assert.equal(m.falseCompletionRate, 0);
    assert.equal(m.rollbackRate, 0);
    assert.equal(m.humanEscalationRate, 0);
  });

  it('computes rates from counts', () => {
    const m = computeMetrics({
      ...baseEvidence(),
      success: false,
      tests: { passed: 15, total: 20 },
      regressions: 2,
      reviewRounds: 4,
      reviewRejections: 1,
      fixLoops: 4,
      toolCalls: 100,
      toolErrors: 10,
      completionClaims: 2,
      falseCompletions: 1,
      deployments: 2,
      rollbacks: 1,
      decisions: 5,
      escalations: 2,
    });
    assert.equal(m.taskSuccess, 0);
    assert.equal(m.testPassRate, 0.75);
    assert.equal(m.regressionRate, 0.1);
    assert.equal(m.reviewRejectionRate, 0.25);
    assert.equal(m.loopEfficiency, 0.25);
    assert.equal(m.toolErrorRate, 0.1);
    assert.equal(m.falseCompletionRate, 0.5);
    assert.equal(m.rollbackRate, 0.5);
    assert.equal(m.humanEscalationRate, 0.4);
  });

  it('treats empty denominators as 0 rates instead of NaN', () => {
    const m = computeMetrics({
      ...baseEvidence(),
      tests: { passed: 0, total: 0 },
      reviewRounds: 0,
      reviewRejections: 0,
      toolCalls: 0,
      toolErrors: 0,
      completionClaims: 0,
      deployments: 0,
      decisions: 0,
    });
    assert.equal(m.testPassRate, 0);
    assert.equal(m.regressionRate, 0);
    assert.equal(m.reviewRejectionRate, 0);
    assert.equal(m.toolErrorRate, 0);
    assert.equal(m.falseCompletionRate, 0);
    assert.equal(m.rollbackRate, 0);
    assert.equal(m.humanEscalationRate, 0);
  });

  it('decays loop efficiency with each repair loop', () => {
    assert.equal(computeMetrics({ ...baseEvidence(), fixLoops: 1 }).loopEfficiency, 1);
    assert.equal(computeMetrics({ ...baseEvidence(), fixLoops: 2 }).loopEfficiency, 0.5);
    assert.equal(computeMetrics({ ...baseEvidence(), fixLoops: 10 }).loopEfficiency, 0.1);
  });

  it('clamps nonsensical counts to 0..1', () => {
    const m = computeMetrics({ ...baseEvidence(), reviewRejections: 9, reviewRounds: 2 });
    assert.equal(m.reviewRejectionRate, 1);
  });
});

describe('weightedScore / verdictFor', () => {
  it('scores a perfect evaluation at 1.0 → EXCELLENT', () => {
    const m = computeMetrics(baseEvidence());
    assert.equal(weightedScore(m), 1);
    assert.equal(verdictFor(m, 1), 'EXCELLENT');
  });

  it('maps score bands to verdicts', () => {
    const m = computeMetrics(baseEvidence());
    assert.equal(verdictFor(m, 0.8), 'GOOD');
    assert.equal(verdictFor(m, 0.6), 'ACCEPTABLE');
    assert.equal(verdictFor(m, 0.4), 'POOR');
    assert.equal(verdictFor(m, 0.1), 'FAIL');
  });

  it('caps a failed task at POOR even when everything else was perfect', () => {
    const m = computeMetrics({ ...baseEvidence(), success: false });
    const score = weightedScore(m);
    assert.ok(score > 0.5, `expected raw score > 0.5, got ${score}`);
    const verdict = verdictFor(m, score);
    assert.ok(
      verdict === 'POOR' || verdict === 'FAIL',
      `expected at most POOR, got ${verdict}`,
    );
  });

  it('caps high false-completion rates at POOR regardless of score', () => {
    const m = computeMetrics({
      ...baseEvidence(),
      completionClaims: 10,
      falseCompletions: 5,
    });
    const verdict = verdictFor(m, weightedScore(m));
    assert.ok(
      verdict === 'POOR' || verdict === 'FAIL',
      `expected at most POOR, got ${verdict}`,
    );
  });
});
