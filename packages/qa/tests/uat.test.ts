/**
 * Tests for v2 §38.4 UAT: human-judgment ACs stay WAITING, drift fails, redaction.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UatManager } from '../src/index';

describe('UatManager', () => {
  it('starts a session in RUNNING state', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'cand-1', mode: 'both', humanJudgmentAcIds: ['AC-UX-1'] });
    assert.equal(s.status, 'RUNNING');
    assert.deepEqual(s.humanJudgmentAcIds, ['AC-UX-1']);
  });

  it('requires taskId and candidateDigest', () => {
    const m = new UatManager();
    assert.throws(() => m.start({ taskId: '', candidateDigest: 'c', mode: 'auto' }), /taskId/);
    assert.throws(() => m.start({ taskId: 'T', candidateDigest: '', mode: 'auto' }), /candidateDigest/);
  });

  it('AI-evaluated human-judgment AC is forced to WAITING, never faked PASS', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'c1', mode: 'both', humanJudgmentAcIds: ['AC-UX-1'] });
    const r = m.recordAc(s.id, { acId: 'AC-UX-1', method: 'auto', result: 'PASS', evaluatedBy: 'ai-qa' });
    assert.equal(r.result, 'WAITING');
    assert.equal(m.get(s.id).status, 'WAITING_HUMAN');
  });

  it('verified human evaluation of a human-judgment AC passes', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'c1', mode: 'human', humanJudgmentAcIds: ['AC-UX-1'] });
    m.recordAc(s.id, { acId: 'AC-UX-1', method: 'human', result: 'PASS', evaluatedBy: 'human:owner-1' });
    assert.equal(m.get(s.id).status, 'PASSED');
  });

  it('a plain "human" method without verified identity stays WAITING', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'c1', mode: 'human', humanJudgmentAcIds: ['AC-UX-1'] });
    const r = m.recordAc(s.id, { acId: 'AC-UX-1', method: 'human', result: 'PASS', evaluatedBy: 'ai-agent' });
    assert.equal(r.result, 'WAITING');
  });

  it('any FAIL fails the session', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'c1', mode: 'auto' });
    m.recordAc(s.id, { acId: 'AC-1', method: 'auto', result: 'FAIL' });
    assert.equal(m.get(s.id).status, 'FAILED');
  });

  it('UAT-vs-PROD drift fails the session', () => {
    const m = new UatManager();
    const s = m.start({ taskId: 'T-1', candidateDigest: 'c1', mode: 'auto' });
    m.recordAc(s.id, { acId: 'AC-1', method: 'auto', result: 'PASS' });
    m.recordDriftCheck(s.id, true, 'DB schema differs');
    assert.equal(m.get(s.id).status, 'FAILED');
  });

  it('unknown session id throws', () => {
    const m = new UatManager();
    assert.throws(() => m.get('nope'), /not found/);
  });
});
