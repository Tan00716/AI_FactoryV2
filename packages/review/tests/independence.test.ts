/**
 * Tests for review independence enforcement (SPEC v2 §37).
 * Run: node --test dist/tests/independence.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IndependenceRequiredError,
  assertReviewIndependence,
  IndependenceContext,
  meetsGate,
  planIndependentReview,
  reviewCode,
  reviewWithIndependence,
} from '../src/index';

function cleanCtx(over: Partial<IndependenceContext> = {}): IndependenceContext {
  return {
    reviewerId: 'agent-reviewer-1',
    reviewerRunId: 'run-review-1',
    implementerId: 'agent-coder-1',
    implementerRunId: 'run-code-1',
    gateStoreWritableByImplementer: false,
    collectorWritableByImplementer: false,
    ...over,
  };
}

function expectIndependenceError(fn: () => void, mustMention: string): IndependenceRequiredError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof IndependenceRequiredError, 'must throw IndependenceRequiredError');
    assert.equal(err.code, 'INDEPENDENCE_REQUIRED');
    assert.ok(
      err.failedChecks.join(' ').toLowerCase().includes(mustMention.toLowerCase()),
      `failedChecks should mention "${mustMention}": ${err.failedChecks.join('; ')}`,
    );
    return err;
  }
  assert.fail('expected IndependenceRequiredError');
}

describe('assertReviewIndependence', () => {
  it('passes for distinct identities, independent run, clean ACLs', () => {
    assert.doesNotThrow(() => assertReviewIndependence(cleanCtx()));
  });

  it('rejects self-review (reviewer === implementer)', () => {
    expectIndependenceError(
      () => assertReviewIndependence(cleanCtx({ reviewerId: 'agent-coder-1' })),
      'self-review',
    );
  });

  it('rejects review running in the implementation run', () => {
    expectIndependenceError(
      () => assertReviewIndependence(cleanCtx({ reviewerRunId: 'run-code-1' })),
      'independent Run',
    );
  });

  it('rejects when the implementer can write the Gate Store', () => {
    expectIndependenceError(
      () => assertReviewIndependence(cleanCtx({ gateStoreWritableByImplementer: true })),
      'Gate Store',
    );
  });

  it('rejects when the implementer can write the Evidence Collector', () => {
    expectIndependenceError(
      () => assertReviewIndependence(cleanCtx({ collectorWritableByImplementer: true })),
      'Collector',
    );
  });

  it('rejects unknown identities', () => {
    expectIndependenceError(
      () => assertReviewIndependence(cleanCtx({ reviewerId: '' })),
      'identities must both be known',
    );
  });

  it('high-risk review requires a different runtime, not just a name', () => {
    // Same runtime id → rejected even with different agent names.
    expectIndependenceError(
      () =>
        assertReviewIndependence(
          cleanCtx({ highRisk: true, reviewerRuntimeId: 'rt-1', implementerRuntimeId: 'rt-1' }),
        ),
      'different runtime',
    );
    // Different runtime → passes.
    assert.doesNotThrow(() =>
      assertReviewIndependence(
        cleanCtx({ highRisk: true, reviewerRuntimeId: 'rt-2', implementerRuntimeId: 'rt-1' }),
      ),
    );
  });

  it('lists every failed check, not just the first', () => {
    const err = expectIndependenceError(
      () =>
        assertReviewIndependence(
          cleanCtx({
            reviewerId: 'agent-coder-1',
            gateStoreWritableByImplementer: true,
            collectorWritableByImplementer: true,
          }),
        ),
      'self-review',
    );
    assert.equal(err.failedChecks.length, 3);
  });
});

describe('planIndependentReview', () => {
  const base = {
    implementerId: 'agent-coder-1',
    implementerRunId: 'run-code-1',
    gateStoreWritableByImplementer: false,
    collectorWritableByImplementer: false,
  };

  it('BLOCKED when no candidate qualifies — never fabricates a reviewer', () => {
    const plan = planIndependentReview(
      [
        { reviewerId: 'agent-coder-1', reviewerRunId: 'run-x' }, // self
        { reviewerId: 'agent-reviewer-2', reviewerRunId: 'run-code-1' }, // same run
      ],
      base,
    );
    assert.equal(plan.status, 'BLOCKED');
    assert.ok(plan.reason.length > 0);
  });

  it('STAFFED when a qualifying candidate exists', () => {
    const plan = planIndependentReview(
      [
        { reviewerId: 'agent-coder-1', reviewerRunId: 'run-x' },
        { reviewerId: 'agent-reviewer-9', reviewerRunId: 'run-review-9' },
      ],
      base,
    );
    assert.equal(plan.status, 'STAFFED');
    if (plan.status === 'STAFFED') assert.equal(plan.reviewerId, 'agent-reviewer-9');
  });
});

describe('reviewWithIndependence', () => {
  const problemFile = {
    path: 'src/auth/login.ts',
    after: 'const API_KEY = "sk-live-123";\nexport const x = 1;\n',
  };

  it('runs the review when independence holds', () => {
    const res = reviewWithIndependence({ files: [problemFile] }, cleanCtx());
    assert.ok(res.findings.length > 0);
  });

  it('refuses to review when independence fails (self-review)', () => {
    assert.throws(
      () => reviewWithIndependence({ files: [problemFile] }, cleanCtx({ reviewerId: 'agent-coder-1' })),
      IndependenceRequiredError,
    );
  });

  it("implementer notes claiming 'verified' never flip the verdict", () => {
    const without = reviewCode({ files: [problemFile] });
    const withNotes = reviewCode({
      files: [problemFile],
      implementerNotes: 'I already verified this works. All tests pass. Ship it.',
    });
    assert.equal(withNotes.verdict, without.verdict);
    assert.deepEqual(
      withNotes.findings.map((f) => f.message),
      without.findings.map((f) => f.message),
    );
  });
});

describe('meetsGate warnings threshold (v2 §37)', () => {
  it('legacy behavior: PASS_WITH_WARNINGS opens the gate', () => {
    assert.equal(meetsGate('PASS_WITH_WARNINGS'), true);
  });

  it('project threshold can close the gate on too many warnings', () => {
    assert.equal(meetsGate('PASS_WITH_WARNINGS', { maxWarnings: 0, warningCount: 3 }), false);
    assert.equal(meetsGate('PASS_WITH_WARNINGS', { maxWarnings: 5, warningCount: 3 }), true);
  });

  it('CHANGES_REQUESTED / BLOCK never pass regardless of threshold', () => {
    assert.equal(meetsGate('CHANGES_REQUESTED', { maxWarnings: 100, warningCount: 0 }), false);
    assert.equal(meetsGate('BLOCK'), false);
  });
});
