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
