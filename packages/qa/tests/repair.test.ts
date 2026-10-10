/**
 * Tests for v2 §38.3 repair tracking: fingerprinting, stagnation, budget,
 * and the independent-review requirement for test changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  failureFingerprint,
  RepairBudgetExceededError,
  RepairTracker,
  StagnationError,
  UnreviewedTestChangeError,
} from '../src/index';

describe('failureFingerprint', () => {
  it('is stable for the same failure and insensitive to volatile bits', () => {
    const a = failureFingerprint('AssertionError: expected 200 to be 201 at 2026-10-10T12:00:00Z (0xabc123)');
    const b = failureFingerprint('AssertionError: expected 200 to be 201 at 2026-10-11T09:30:00Z (0xdef456)');
    assert.equal(a, b);
  });

  it('differs for genuinely different failures', () => {
    const a = failureFingerprint('AssertionError: expected 200 to be 201');
    const b = failureFingerprint('ECONNREFUSED 127.0.0.1:5432');
    assert.notEqual(a, b);
  });
});

describe('RepairTracker stagnation', () => {
  it('throws StagnationError on the 3rd identical fingerprint with no progress', () => {
    const t = new RepairTracker({ maxAttempts: 10 });
    const msg = 'AssertionError: expected 200 to be 201';
    t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    assert.throws(
      () => t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false }),
      StagnationError,
    );
  });

  it('no stagnation when there is substantive progress between repeats', () => {
    const t = new RepairTracker({ maxAttempts: 10 });
    const msg = 'AssertionError: expected 200 to be 201';
    t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: true });
    t.recordAttempt({ message: msg, classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    assert.equal(t.getAttempts().length, 3);
  });

  it('no stagnation when the fingerprint changes', () => {
    const t = new RepairTracker({ maxAttempts: 10 });
    t.recordAttempt({ message: 'fail A', classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    t.recordAttempt({ message: 'fail B', classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    t.recordAttempt({ message: 'fail C', classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: false });
    assert.equal(t.getAttempts().length, 3);
  });
});

describe('RepairTracker budget', () => {
  it('throws RepairBudgetExceededError when maxAttempts is reached', () => {
    const t = new RepairTracker({ maxAttempts: 2 });
    t.recordAttempt({ message: 'fail A', classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: true });
    assert.throws(
      () => t.recordAttempt({ message: 'fail B', classification: 'PRODUCT_FAILURE', owner: 'coder', substantiveProgress: true }),
      RepairBudgetExceededError,
    );
  });
});

describe('test-change review requirement', () => {
  it('refuses unreviewed or self-reviewed test/fixture/threshold changes', () => {
    assert.throws(
      () => RepairTracker.assertTestChangeReviewed({ kind: 'test', description: 'relax timeout', authorId: 'coder-1' }),
      UnreviewedTestChangeError,
    );
    assert.throws(
      () =>
        RepairTracker.assertTestChangeReviewed({
          kind: 'threshold',
          description: 'lower coverage gate',
          authorId: 'coder-1',
          reviewedById: 'coder-1',
        }),
      UnreviewedTestChangeError,
    );
  });

  it('accepts an independently reviewed change', () => {
    assert.doesNotThrow(() =>
      RepairTracker.assertTestChangeReviewed({
        kind: 'fixture',
        description: 'fix stale fixture',
        authorId: 'coder-1',
        reviewedById: 'qa-lead',
      }),
    );
  });
});
