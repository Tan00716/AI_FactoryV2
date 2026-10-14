/**
 * Tests for RequirementManager — SPEC_V2 §16.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateRequirementInput,
  RequirementManager,
} from '../src/index';

const NOW = 1700000000000;

function mgr() {
  return new RequirementManager({ now: () => NOW });
}

function baseInput(over: Partial<CreateRequirementInput> = {}): CreateRequirementInput {
  return {
    businessGoal: 'Ship feature X',
    acceptanceCriteria: [
      {
        id: 'AC-001', description: 'X works',
        verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result with verdict PASS',
        applicableEnvironments: ['dev', 'uat'],
      },
    ],
    outcomeMeasurement: 'adoption > 10%',
    createdBy: 'human-1',
    ...over,
  };
}

describe('create', () => {
  it('assigns persistent id, immutable v1, default target RELEASED_OUTCOME', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.match(r.id, /^REQ-/);
    assert.equal(r.versions.length, 1);
    assert.equal(r.versions[0].version, 1);
    assert.equal(r.versions[0].completionTarget, 'RELEASED_OUTCOME');
    assert.equal(r.versions[0].acceptanceCriteria[0].version, 1);
  });

  it('ACs need stable ids, unique, with expectedEvidence', () => {
    const m = mgr();
    assert.throws(
      () => m.create(baseInput({ acceptanceCriteria: [{ ...baseInput().acceptanceCriteria[0], id: '' }] })),
      /stable id/,
    );
    const dup = baseInput().acceptanceCriteria[0];
    assert.throws(
      () => m.create(baseInput({ acceptanceCriteria: [dup, { ...dup }] })),
      /Duplicate AC id/,
    );
  });

  it('VERIFIED_DELIVERY without eligible category + HUMAN authorization is rejected (§16 G-03)', () => {
    const m = mgr();
    // No category, no HUMAN authorization: rejected at create() itself.
    assert.throws(
      () => m.create(baseInput({ completionTarget: 'VERIFIED_DELIVERY' })),
      /VERIFIED_DELIVERY/,
    );
    // A recorded free-text basis alone is NOT an authorization anymore.
    assert.throws(
      () => m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        projectCategory: 'DOCUMENTATION',
        releaseNaAuthorization: { authorizedBy: 'human-1', reason: 'docs only', at: '2026-10-10T00:00:00Z' },
      })),
      /HUMAN authorization/,
    );
    const r = m.create(baseInput({
      completionTarget: 'VERIFIED_DELIVERY',
      projectCategory: 'DOCUMENTATION',
      completionTargetAuthorization: { authorizedBy: 'human-1', isHuman: true, reason: 'docs only' },
      releaseNaAuthorization: { authorizedBy: 'human-1', reason: 'docs only', at: '2026-10-10T00:00:00Z' },
    }));
    assert.equal(r.versions[0].completionTarget, 'VERIFIED_DELIVERY');
    assert.equal(r.versions[0].projectCategory, 'DOCUMENTATION');
  });
});

describe('immutable versions', () => {
  it('newVersion appends; old records are never mutated', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const before = JSON.stringify(m.getVersion(r.id, 1));
    m.newVersion(r.id, 'CORRECTION', 'fix typo', 'human-1', (d) => {
      d.businessGoal = 'Ship feature X (updated)';
    });
    assert.equal(m.getVersion(r.id, 1).businessGoal, 'Ship feature X');
    assert.equal(JSON.stringify(m.getVersion(r.id, 1)), before);
    assert.equal(m.latest(r.id).version, 2);
    assert.equal(m.latest(r.id).businessGoal, 'Ship feature X (updated)');
  });
});

describe('AC refinement (§16: AI PM may refine, not change meaning)', () => {
  it('refinement keeps the AC id and bumps the AC version', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.proposeAcRefinement(r.id, 'AC-001', { description: 'X works fast' }, 'ai-pm-1');
    const ac = v2.acceptanceCriteria.find((a) => a.id === 'AC-001')!;
    assert.equal(ac.description, 'X works fast');
    assert.equal(ac.version, 2);
    assert.equal(v2.changeKind, 'AC_REFINEMENT');
    assert.equal(m.getVersion(r.id, 1).acceptanceCriteria[0].description, 'X works');
  });

  it('refinement adding new product behavior is rejected → Proposal flow', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.proposeAcRefinement(r.id, 'AC-001', { addsNewBehavior: true }, 'ai-pm-1'),
      /Proposal/,
    );
  });

  it('refining an unknown AC id fails', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.proposeAcRefinement(r.id, 'AC-999', { description: 'x' }, 'ai-pm-1'),
      /not found/,
    );
  });
});

describe('completion_target (§16: AI may not move the endpoint)', () => {
  it('non-human authorization is rejected', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.changeCompletionTarget(r.id, 'VERIFIED_DELIVERY', { authorizedBy: 'ai-pm-1', isHuman: false, reason: 'faster' }, 'ai-pm-1'),
      /HUMAN authorization/,
    );
  });

  it('human authorization records the N/A basis', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.changeCompletionTarget(
      r.id, 'VERIFIED_DELIVERY',
      { authorizedBy: 'human-1', isHuman: true, reason: 'research spike, no prod' },
      'human-1',
    );
    assert.equal(v2.completionTarget, 'VERIFIED_DELIVERY');
    assert.equal(v2.releaseNaAuthorization?.authorizedBy, 'human-1');
  });

  it('sneaking a target change through newVersion is rejected', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'CORRECTION', 'sneaky', 'ai-pm-1', (d) => {
        d.completionTarget = 'IMPLEMENTATION';
      }),
      /TARGET_CHANGE/,
    );
  });
});

describe('countConsecutiveAcRefinements (Batch 42)', () => {
  it('counts trailing AC_REFINEMENT versions; other kinds break the streak', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.equal(m.countConsecutiveAcRefinements(r.id), 0);
    m.proposeAcRefinement(r.id, 'AC-001', { description: 'clearer' }, 'agent:pm');
    m.proposeAcRefinement(r.id, 'AC-001', { description: 'even clearer' }, 'agent:pm');
    assert.equal(m.countConsecutiveAcRefinements(r.id), 2);
    // A non-refinement version resets the streak.
    m.newVersion(r.id, 'SCOPE_CHANGE', 'scope grew', 'human:po', (d) => {
      d.businessGoal = 'Ship bigger feature X';
    });
    assert.equal(m.countConsecutiveAcRefinements(r.id), 0);
    m.proposeAcRefinement(r.id, 'AC-001', { description: 'clearest' }, 'agent:pm');
    assert.equal(m.countConsecutiveAcRefinements(r.id), 1);
  });

  it('throws for unknown requirement', () => {
    const m = mgr();
    assert.throws(() => m.countConsecutiveAcRefinements('REQ-NOPE'), /not found/i);
  });
});
