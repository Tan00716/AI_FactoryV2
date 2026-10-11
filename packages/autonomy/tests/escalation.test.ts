/**
 * Tests for needsHuman / evaluateEscalation — §81 human exception handling.
 * Run: node --test dist/tests/escalation.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN_NEED_REASONS,
  HumanNeedReason,
  evaluateEscalation,
  isHumanNeedReason,
  needsHuman,
} from '../src/index';

const FIXED_NOW = 1728374400000;
const now = () => FIXED_NOW;

describe('needsHuman — the eight §81 triggers', () => {
  const cases: HumanNeedReason[] = [
    'requirement-ambiguity',
    'policy-violation',
    'repeated-failure',
    'budget-exceeded',
    'high-risk-deployment',
    'security-issue',
    'irrecoverable-env-error',
    'ai-disagreement',
  ];

  it('lists exactly the eight spec triggers', () => {
    assert.deepEqual([...HUMAN_NEED_REASONS], cases);
  });

  for (const reason of cases) {
    it(`escalates '${reason}' with a full record`, () => {
      const rec = needsHuman(reason, {
        now,
        detail: 'test detail',
        context: { taskId: 't-1' },
      });
      assert.equal(rec.reason, reason);
      assert.ok(typeof rec.id === 'string' && rec.id.length > 0);
      assert.ok(rec.reasonZh.length > 0);
      assert.ok(['medium', 'high', 'critical'].includes(rec.severity));
      assert.equal(rec.detail, 'test detail');
      assert.deepEqual(rec.context, { taskId: 't-1' });
      assert.equal(rec.detectedAt, new Date(FIXED_NOW).toISOString());
    });
  }

  it('marks security issues and policy violations as critical', () => {
    assert.equal(needsHuman('security-issue', { now }).severity, 'critical');
    assert.equal(needsHuman('policy-violation', { now }).severity, 'critical');
    assert.equal(needsHuman('irrecoverable-env-error', { now }).severity, 'critical');
  });
});

describe('evaluateEscalation', () => {
  it('returns a record for a known trigger', () => {
    const rec = evaluateEscalation('budget-exceeded', { now });
    assert.ok(rec !== null);
    assert.equal(rec!.reason, 'budget-exceeded');
    assert.equal(rec!.reasonZh, '预算超限');
  });

  it('returns null for routine work — no "should I run the tests?" nagging', () => {
    assert.equal(evaluateEscalation('should-i-run-the-tests'), null);
    assert.equal(evaluateEscalation(''), null);
    assert.equal(evaluateEscalation('run-tests'), null);
  });

  it('isHumanNeedReason guards arbitrary strings', () => {
    assert.equal(isHumanNeedReason('ai-disagreement'), true);
    assert.equal(isHumanNeedReason('coffee-break'), false);
    assert.equal(isHumanNeedReason(undefined), false);
  });
});

describe('EscalationRecord §15 contract fields (additive)', () => {
  it('carries the 8 optional escalation-contract fields when provided', () => {
    const rec = needsHuman('security-issue', {
      now: () => 1_700_000_000_000,
      originalCommand: 'deploy prod --force',
      authPolicyVersion: 'policy@v7',
      evidenceRefs: ['ev-1', 'ev-2'],
      impactScope: 'prod cluster A',
      stoppedActions: ['deploy.prod'],
      suggestion: 'revoke the capability and rotate the key',
      deadline: '2026-10-12T00:00:00.000Z',
      recipient: 'human:alice',
    });
    assert.equal(rec.originalCommand, 'deploy prod --force');
    assert.equal(rec.authPolicyVersion, 'policy@v7');
    assert.deepEqual(rec.evidenceRefs, ['ev-1', 'ev-2']);
    assert.equal(rec.impactScope, 'prod cluster A');
    assert.deepEqual(rec.stoppedActions, ['deploy.prod']);
    assert.equal(rec.suggestion, 'revoke the capability and rotate the key');
    assert.equal(rec.deadline, '2026-10-12T00:00:00.000Z');
    assert.equal(rec.recipient, 'human:alice');
  });

  it('the new fields are optional — old callers unaffected', () => {
    const rec = needsHuman('budget-exceeded', { now: () => 1_700_000_000_000 });
    assert.equal(rec.originalCommand, undefined);
    assert.equal(rec.recipient, undefined);
    assert.equal(rec.severity, 'high');
  });
});
