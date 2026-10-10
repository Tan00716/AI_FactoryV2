/**
 * Tests for impact analysis — SPEC_V2 §16:
 * requirement change → affected entities, STALE approvals, suspended
 * promotions, explicit evidence compatibility (no silent reuse).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequirementManager } from '../src/index';

const NOW = 1700000000000;

function mgr() {
  return new RequirementManager({ now: () => NOW });
}

function seeded(): { m: RequirementManager; id: string } {
  const m = mgr();
  const r = m.create({
    businessGoal: 'Ship feature X',
    acceptanceCriteria: [
      {
        id: 'AC-001', description: 'X works',
        verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result PASS', applicableEnvironments: ['dev'],
      },
      {
        id: 'AC-002', description: 'X is fast',
        verificationType: 'PERFORMANCE_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'perf report', applicableEnvironments: ['uat'],
      },
    ],
    outcomeMeasurement: 'adoption',
    createdBy: 'human-1',
  });
  m.linkEntities(r.id, 1, {
    planIds: ['plan-1'],
    taskIds: ['task-1', 'task-2'],
    codeRefs: ['sha256:aaa'],
    testIds: ['test-1'],
    evidenceIds: ['ev-qa-1', 'ev-perf-1'],
    approvalIds: ['appr-1'],
    releaseIds: ['rel-1'],
  });
  // v2: AC-002 description changed, AC-003 added
  m.newVersion(r.id, 'SCOPE_CHANGE', 'add AC-003, clarify AC-002', 'human-1', (d) => {
    d.acceptanceCriteria.find((a) => a.id === 'AC-002')!.description = 'X is fast (<100ms p95)';
    d.acceptanceCriteria.push({
      id: 'AC-003', version: 1, description: 'X is accessible',
      verificationType: 'MANUAL_VERIFICATION', verifiedBy: 'HUMAN_OWNER',
      expectedEvidence: 'a11y checklist signed', applicableEnvironments: ['uat'],
    });
  });
  return { m, id: r.id };
}

describe('analyzeImpact', () => {
  it('diffs ACs: added / changed detected', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.deepEqual(impact.acAdded, ['AC-003']);
    assert.deepEqual(impact.acRemoved, []);
    assert.ok(impact.acChanged.includes('AC-002'));
  });

  it('collects affected entities across all seven dimensions', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.deepEqual(impact.affected.taskIds, ['task-1', 'task-2']);
    assert.deepEqual(impact.affected.planIds, ['plan-1']);
    assert.deepEqual(impact.affected.codeRefs, ['sha256:aaa']);
    assert.deepEqual(impact.affected.testIds, ['test-1']);
    assert.deepEqual(impact.affected.evidenceIds, ['ev-qa-1', 'ev-perf-1']);
    assert.deepEqual(impact.affected.approvalIds, ['appr-1']);
    assert.deepEqual(impact.affected.releaseIds, ['rel-1']);
  });

  it('marks old-version approvals STALE and suspends affected promotions', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.deepEqual(impact.staleApprovals, ['appr-1']);
    assert.equal(impact.suspendedPromotions.length, 2);
    assert.ok(impact.suspendedPromotions.every((h) => h.releasedAt === null));
    assert.ok(impact.staleGates.includes('gate:task-1'));
  });

  it('old evidence is stale until explicitly compatibility-checked (no silent reuse)', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.deepEqual(impact.evidenceStale.sort(), ['ev-perf-1', 'ev-qa-1']);
    assert.deepEqual(impact.evidenceReusable, []);
    assert.equal(m.canReuseEvidence('ev-qa-1', id, 2), false);

    m.checkEvidenceCompatibility('ev-qa-1', id, 2, true, 'AC-001 unchanged in v2', 'qa-lead');
    assert.equal(m.canReuseEvidence('ev-qa-1', id, 2), true);
    assert.equal(m.canReuseEvidence('ev-perf-1', id, 2), false);

    const impact2 = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    assert.deepEqual(impact2.evidenceReusable, ['ev-qa-1']);
    assert.deepEqual(impact2.evidenceStale, ['ev-perf-1']);
  });

  it('incompatible evidence is never reusable', () => {
    const { m, id } = seeded();
    m.checkEvidenceCompatibility('ev-perf-1', id, 2, false, 'AC-002 threshold changed', 'qa-lead');
    assert.equal(m.canReuseEvidence('ev-perf-1', id, 2), false);
  });

  it('releasing a hold requires a revalidation note', () => {
    const { m, id } = seeded();
    const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-1');
    const hold = impact.suspendedPromotions[0];
    assert.throws(() => m.releaseHold(hold.id, 'human-1', ''), /revalidation note/);
    const released = m.releaseHold(hold.id, 'human-1', 're-planned against REQ@2');
    assert.ok(released.releasedAt !== null);
    assert.equal(released.releasedBy, 'human-1');
  });
});
