/**
 * Tests for PromotionHold enforcement — SPEC_V2 §16 G-05:
 * analyzeImpact() records holds; the promotion gate must actually query
 * them (activeHolds / isPromotionHeld / assertPromotionAllowed), repeated
 * impact analysis must not stack duplicate holds, and release re-opens
 * the gate. The manager-layer assertions here are the exact semantics
 * the POST /api/requirements/promotion-check route exposes
 * (200 {allowed:true} ⇔ no throw; 409 {allowed:false, holds} ⇔ throw).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PromotionHeldError, RequirementManager } from '../src/index';

const NOW = 1700000000000;

function seeded(): { m: RequirementManager; id: string } {
  const m = new RequirementManager({ now: () => NOW });
  const r = m.create({
    businessGoal: 'Ship feature X',
    acceptanceCriteria: [
      {
        id: 'AC-001', description: 'X works',
        verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result PASS', applicableEnvironments: ['dev'],
      },
    ],
    outcomeMeasurement: 'adoption',
    createdBy: 'human-1',
  });
  m.linkEntities(r.id, 1, { taskIds: ['task-1', 'task-2'] });
  m.newVersion(r.id, 'SCOPE_CHANGE', 'clarify AC-001', 'human-1', (d) => {
    d.acceptanceCriteria[0].description = 'X works reliably';
  });
  return { m, id: r.id };
}

describe('PromotionHold gate (§16 G-05)', () => {
  it('no holds → promotion allowed', () => {
    const { m } = seeded();
    assert.equal(m.isPromotionHeld('task-1'), false);
    assert.deepEqual(m.activeHolds('task-1'), []);
    assert.doesNotThrow(() => m.assertPromotionAllowed('task-1'));
  });

  it('analyzeImpact → assertPromotionAllowed throws PromotionHeldError naming hold, requirement@version and reason', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const hold = impact.suspendedPromotions.find((h) => h.taskId === 'task-1')!;

    assert.equal(m.isPromotionHeld('task-1'), true);
    assert.deepEqual(m.activeHolds('task-1').map((h) => h.id), [hold.id]);

    assert.throws(
      () => m.assertPromotionAllowed('task-1'),
      (err: unknown) => {
        assert.ok(err instanceof PromotionHeldError);
        assert.ok(err.message.includes(hold.id), 'message names the hold id');
        assert.ok(err.message.includes(`${id}@2`), 'message names requirementId@version');
        assert.ok(err.message.includes(hold.reason), 'message carries the hold reason');
        assert.deepEqual(err.holds.map((h) => h.id), [hold.id]);
        return true;
      },
    );
  });

  it('holds are per-task: an unaffected task stays promotable', () => {
    const { m, id } = seeded();
    m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.equal(m.isPromotionHeld('task-unknown'), false);
    assert.doesNotThrow(() => m.assertPromotionAllowed('task-unknown'));
  });

  it('releaseHold re-opens the gate (promotion-check 200 semantics)', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const hold = impact.suspendedPromotions.find((h) => h.taskId === 'task-1')!;

    m.releaseHold(hold.id, 'human-1', 're-planned against REQ@2');
    assert.equal(m.isPromotionHeld('task-1'), false);
    assert.deepEqual(m.activeHolds('task-1'), []);
    assert.doesNotThrow(() => m.assertPromotionAllowed('task-1'));
    // The released hold is still listed for audit, just no longer active.
    assert.equal(m.listHolds('task-1').length, 1);
    assert.ok(m.listHolds('task-1')[0].releasedAt !== null);
  });

  it('repeated analyzeImpact for the same task+requirement+toVersion does not stack holds', () => {
    const { m, id } = seeded();
    const first = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const second = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.equal(m.listHolds().length, 2); // task-1 + task-2, not 4
    assert.equal(m.activeHolds('task-1').length, 1);
    assert.deepEqual(
      second.suspendedPromotions.map((h) => h.id).sort(),
      first.suspendedPromotions.map((h) => h.id).sort(),
    );
  });

  it('a released hold does not dedup: re-analysis creates a fresh hold', () => {
    const { m, id } = seeded();
    const first = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const hold = first.suspendedPromotions.find((h) => h.taskId === 'task-1')!;
    m.releaseHold(hold.id, 'human-1', 're-planned against REQ@2');
    assert.doesNotThrow(() => m.assertPromotionAllowed('task-1'));

    const again = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const fresh = again.suspendedPromotions.find((h) => h.taskId === 'task-1')!;
    assert.notEqual(fresh.id, hold.id);
    assert.equal(m.isPromotionHeld('task-1'), true);
    assert.equal(m.listHolds('task-1').length, 2);
  });

  it('a hold for a different toVersion is a separate hold (dedup key includes version)', () => {
    const { m, id } = seeded();
    m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    m.linkEntities(id, 2, { taskIds: ['task-1'] });
    m.newVersion(id, 'SCOPE_CHANGE', 'clarify again', 'human-1', (d) => {
      d.acceptanceCriteria[0].description = 'X works reliably and fast';
    });
    m.analyzeImpact(id, 2, 3, 'ai-pm-1');
    assert.equal(m.activeHolds('task-1').length, 2);
    assert.throws(() => m.assertPromotionAllowed('task-1'), PromotionHeldError);
  });
});
