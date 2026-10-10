/**
 * Tests for v2 §38.2 flake quarantine: owner+expiry+policy required,
 * append-only attempts, mandatory quarantine ≠ PASS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlakeQuarantine, QuarantineNotFoundError } from '../src/index';

const FUTURE = '2030-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function q(over: Record<string, unknown> = {}) {
  return new FlakeQuarantine({
    now: () => new Date('2026-10-10T00:00:00.000Z').getTime(),
    ...over,
  } as never);
}

describe('FlakeQuarantine', () => {
  it('retains every attempt, append-only', () => {
    const f = q();
    f.recordAttempt('t-1', false, 'first');
    f.recordAttempt('t-1', true, 'second');
    f.recordAttempt('t-1', false, 'third');
    const attempts = f.getAttempts('t-1');
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((a) => a.passed), [false, true, false]);
    // ids are unique — no attempt was overwritten
    assert.equal(new Set(attempts.map((a) => a.attemptId)).size, 3);
  });

  it('quarantine requires owner, policyRef and a future expiry', () => {
    const f = q();
    assert.throws(
      () => f.quarantine({ testId: 't-1', owner: '', expiresAt: FUTURE, policyRef: 'P-1', reason: 'r', quarantinedBy: 'qa' }),
      /owner/,
    );
    assert.throws(
      () => f.quarantine({ testId: 't-1', owner: 'qa-lead', expiresAt: FUTURE, policyRef: '', reason: 'r', quarantinedBy: 'qa' }),
      /policyRef/,
    );
    assert.throws(
      () => f.quarantine({ testId: 't-1', owner: 'qa-lead', expiresAt: PAST, policyRef: 'P-1', reason: 'r', quarantinedBy: 'qa' }),
      /expiresAt/,
    );
  });

  it('valid quarantine is listed while active and lapses after expiry', () => {
    let nowMs = new Date('2026-10-10T00:00:00.000Z').getTime();
    const f = new FlakeQuarantine({ now: () => nowMs });
    f.quarantine({ testId: 't-1', owner: 'qa-lead', expiresAt: FUTURE, policyRef: 'FLAKE-POLICY-1', reason: 'infra flake', quarantinedBy: 'qa-lead' });
    assert.equal(f.isQuarantined('t-1'), true);
    assert.equal(f.listActive().length, 1);
    // Time passes beyond expiry → quarantine lapses, must be renewed.
    nowMs = new Date('2031-01-01T00:00:00.000Z').getTime();
    assert.equal(f.isQuarantined('t-1'), false);
    assert.equal(f.listActive().length, 0);
  });

  it('release removes the quarantine; unknown test throws', () => {
    const f = q();
    f.quarantine({ testId: 't-1', owner: 'qa-lead', expiresAt: FUTURE, policyRef: 'P-1', reason: 'r', quarantinedBy: 'qa' });
    f.release('t-1');
    assert.equal(f.isQuarantined('t-1'), false);
    assert.throws(() => f.getRecord('t-1'), QuarantineNotFoundError);
    assert.throws(() => f.release('nope'), QuarantineNotFoundError);
  });
});
