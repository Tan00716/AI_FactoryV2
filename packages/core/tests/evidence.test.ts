/**
 * Unit tests for the evidence engine (spec §42 — immutability once
 * evidence is consumed by a gate).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceEngine, EvidenceSealedError } from '../src/index';

describe('evidence engine', () => {
  it('creates DRAFT evidence that can be updated and deleted', () => {
    const eng = new EvidenceEngine();
    const ev = eng.create({
      taskId: 't1', type: 'qa_result', title: 'QA run',
      payload: { verdict: 'PASS' }, createdBy: 'qa',
    });
    assert.equal(ev.status, 'DRAFT');

    const updated = eng.update(ev.id, { payload: { verdict: 'PASS', total: 10, passed: 10 } });
    assert.equal((updated.payload as { total: number }).total, 10);

    eng.delete(ev.id);
    assert.throws(() => eng.get(ev.id), /not found/);
  });

  it('sealed evidence cannot be updated or deleted', () => {
    const eng = new EvidenceEngine();
    const ev = eng.create({
      taskId: 't1', type: 'code_review', title: 'review',
      payload: { verdict: 'PASS' }, createdBy: 'reviewer',
    });
    eng.seal(ev.id);
    assert.equal(eng.statusOf(ev.id), 'SEALED');
    assert.throws(() => eng.update(ev.id, { title: 'tampered' }), EvidenceSealedError);
    assert.throws(() => eng.delete(ev.id), EvidenceSealedError);
    // The stored record is unchanged.
    assert.equal(eng.get(ev.id).title, 'review');
  });

  it('seal is idempotent', () => {
    const eng = new EvidenceEngine();
    const ev = eng.create({
      taskId: 't1', type: 'plan', title: 'p', payload: {}, createdBy: 'pm',
    });
    eng.seal(ev.id);
    eng.seal(ev.id);
    assert.equal(eng.statusOf(ev.id), 'SEALED');
  });

  it('records the requirement version it was collected against (§16/§18.2, Batch 8)', () => {
    const eng = new EvidenceEngine();
    const pinned = eng.create({
      taskId: 't1', type: 'plan', title: 'p', payload: {}, createdBy: 'pm',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(pinned.requirementVersion, 'REQ-001@1');
    assert.equal(eng.get(pinned.id).requirementVersion, 'REQ-001@1');
    // The recorded version survives sealing (it is part of the record).
    assert.equal(eng.seal(pinned.id).requirementVersion, 'REQ-001@1');

    // No requirement context → null, never an invented version.
    const unpinned = eng.create({
      taskId: 't1', type: 'plan', title: 'p2', payload: {}, createdBy: 'pm',
    });
    assert.equal(unpinned.requirementVersion, null);
  });
});
