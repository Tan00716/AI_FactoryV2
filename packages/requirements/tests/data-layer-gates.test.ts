/**
 * Tests for §16 data-layer enforcement (Batch 4, group-b G-01/G-02/G-03):
 * the HUMAN-authorization rules live in create()/newVersion() themselves,
 * not only in the convenience wrappers — so the raw mutation paths that
 * used to bypass them are rejected, while authorized and ordinary flows
 * keep working.
 *
 *  G-01: newVersion(id, 'TARGET_CHANGE', …) could move completion_target
 *        with no HUMAN check at all.
 *  G-02: newVersion() + arbitrary mutate could add new-behavior ACs or
 *        rewrite AC meaning, bypassing proposeAcRefinement()'s
 *        addsNewBehavior rejection.
 *  G-03: create() accepted VERIFIED_DELIVERY with nothing but a
 *        free-text basis — no project-category check, no HUMAN auth.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AcMeaningChangeRejectedError,
  CompletionTargetChangeRejectedError,
  CreateRequirementInput,
  RequirementManager,
  VerifiedDeliveryRejectedError,
} from '../src/index';

const NOW = 1700000000000;

const HUMAN = { authorizedBy: 'human-1', isHuman: true, reason: 'owner decision' };
const AI_AUTH = { authorizedBy: 'ai-pm-1', isHuman: false, reason: 'let me just move it' };

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
      {
        id: 'AC-002', description: 'X is fast',
        verificationType: 'PERFORMANCE_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'perf report',
        applicableEnvironments: ['uat'],
      },
    ],
    outcomeMeasurement: 'adoption > 10%',
    createdBy: 'human-1',
    ...over,
  };
}

describe('G-01: completion_target gate inside newVersion (§16)', () => {
  it('raw TARGET_CHANGE without HUMAN authorization is rejected — the old bypass', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'TARGET_CHANGE', 'move endpoint', 'ai-pm-1', (d) => {
        d.completionTarget = 'IMPLEMENTATION';
      }),
      CompletionTargetChangeRejectedError,
    );
    // Fail-closed: nothing was appended.
    assert.equal(m.latest(r.id).version, 1);
    assert.equal(m.latest(r.id).completionTarget, 'RELEASED_OUTCOME');
  });

  it('TARGET_CHANGE with a non-human "authorization" is rejected', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'TARGET_CHANGE', 'move endpoint', 'ai-pm-1', (d) => {
        d.completionTarget = 'IMPLEMENTATION';
      }, { humanAuthorization: AI_AUTH }),
      /HUMAN authorization/,
    );
    assert.equal(m.latest(r.id).version, 1);
  });

  it('TARGET_CHANGE with a recorded HUMAN authorization succeeds', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.newVersion(r.id, 'TARGET_CHANGE', 'endpoint agreed', 'human-1', (d) => {
      d.completionTarget = 'IMPLEMENTATION';
    }, { humanAuthorization: HUMAN });
    assert.equal(v2.version, 2);
    assert.equal(v2.completionTarget, 'IMPLEMENTATION');
  });

  it('HUMAN-authorized change to VERIFIED_DELIVERY records the N/A basis from the authorization', () => {
    const m = mgr();
    const r = m.create(baseInput({ projectCategory: 'RESEARCH' }));
    const v2 = m.newVersion(r.id, 'TARGET_CHANGE', 'research spike: no release', 'human-1', (d) => {
      d.completionTarget = 'VERIFIED_DELIVERY';
    }, { humanAuthorization: HUMAN });
    assert.equal(v2.completionTarget, 'VERIFIED_DELIVERY');
    assert.equal(v2.releaseNaAuthorization?.authorizedBy, 'human-1');
    assert.equal(v2.releaseNaAuthorization?.reason, 'owner decision');
  });

  it('changeCompletionTarget to VERIFIED_DELIVERY is refused for a known-ineligible project category', () => {
    const m = mgr();
    const r = m.create(baseInput({ projectCategory: 'PRODUCTION_SOFTWARE' }));
    assert.throws(
      () => m.changeCompletionTarget(r.id, 'VERIFIED_DELIVERY', HUMAN, 'human-1'),
      VerifiedDeliveryRejectedError,
    );
    assert.equal(m.latest(r.id).completionTarget, 'RELEASED_OUTCOME');
  });
});

describe('G-02: AC business-meaning gate inside newVersion (§16)', () => {
  it('adding a new-behavior AC via raw mutate is rejected without HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'SCOPE_CHANGE', 'sneak in AC-003', 'ai-pm-1', (d) => {
        d.acceptanceCriteria.push({
          id: 'AC-003', version: 1, description: 'X also does Y',
          verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
          expectedEvidence: 'qa_result PASS', applicableEnvironments: ['dev'],
        });
      }),
      (err: unknown) => {
        assert.ok(err instanceof AcMeaningChangeRejectedError);
        assert.match(err.message, /AC-003/);
        assert.match(err.message, /proposeAcRefinement/);
        return true;
      },
    );
    assert.equal(m.latest(r.id).version, 1);
    assert.equal(m.latest(r.id).acceptanceCriteria.length, 2);
  });

  it('rewriting an AC description via raw mutate is rejected without HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'CORRECTION', 'just a typo fix', 'ai-pm-1', (d) => {
        d.acceptanceCriteria[0].description = 'X works, but only on Tuesdays';
      }),
      AcMeaningChangeRejectedError,
    );
    assert.equal(m.latest(r.id).acceptanceCriteria[0].description, 'X works');
  });

  it('changing an AC semantic field (verifiedBy) is rejected without HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'SCOPE_CHANGE', 'weaken verification', 'ai-pm-1', (d) => {
        d.acceptanceCriteria[0].verifiedBy = 'AI_PM';
      }),
      AcMeaningChangeRejectedError,
    );
  });

  it('changing expectedEvidence is rejected without HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'SCOPE_CHANGE', 'lower the bar', 'ai-pm-1', (d) => {
        d.acceptanceCriteria[0].expectedEvidence = 'a screenshot, maybe';
      }),
      AcMeaningChangeRejectedError,
    );
  });

  it('removing an AC is rejected without HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'SCOPE_CHANGE', 'drop AC-002', 'ai-pm-1', (d) => {
        d.acceptanceCriteria = d.acceptanceCriteria.filter((a) => a.id !== 'AC-002');
      }),
      AcMeaningChangeRejectedError,
    );
    assert.equal(m.latest(r.id).acceptanceCriteria.length, 2);
  });

  it("claiming changeKind 'AC_REFINEMENT' does not forge the refinement path", () => {
    const m = mgr();
    const r = m.create(baseInput());
    assert.throws(
      () => m.newVersion(r.id, 'AC_REFINEMENT', 'refined, trust me', 'ai-pm-1', (d) => {
        d.acceptanceCriteria[0].description = 'completely different behavior';
      }),
      AcMeaningChangeRejectedError,
    );
  });

  it('the same AC changes succeed with a recorded HUMAN authorization', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.newVersion(r.id, 'SCOPE_CHANGE', 'approved: add AC-003, tighten AC-001', 'human-1', (d) => {
      d.acceptanceCriteria[0].description = 'X works reliably';
      d.acceptanceCriteria.push({
        id: 'AC-003', version: 1, description: 'X is accessible',
        verificationType: 'MANUAL_VERIFICATION', verifiedBy: 'HUMAN_OWNER',
        expectedEvidence: 'a11y checklist signed', applicableEnvironments: ['uat'],
      });
    }, { humanAuthorization: HUMAN });
    assert.equal(v2.acceptanceCriteria.length, 3);
    assert.equal(v2.acceptanceCriteria[0].description, 'X works reliably');
  });

  it('non-AC mutations by a non-human caller are NOT gated (ordinary flow unaffected)', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.newVersion(r.id, 'CORRECTION', 'fix goal text', 'ai-pm-1', (d) => {
      d.businessGoal = 'Ship feature X (renamed)';
      d.exclusions = ['no mobile'];
    });
    assert.equal(v2.businessGoal, 'Ship feature X (renamed)');
    assert.deepEqual(v2.exclusions, ['no mobile']);
  });

  it('an AC version bump alone, and environment reordering, are not meaning changes', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.newVersion(r.id, 'CORRECTION', 'bookkeeping', 'ai-pm-1', (d) => {
      d.acceptanceCriteria[0].version += 1;
      d.acceptanceCriteria[0].applicableEnvironments = ['uat', 'dev'];
    });
    assert.equal(v2.acceptanceCriteria[0].version, 2);
    assert.deepEqual(v2.acceptanceCriteria[0].applicableEnvironments, ['uat', 'dev']);
  });

  it('proposeAcRefinement remains the sanctioned non-human clarification path', () => {
    const m = mgr();
    const r = m.create(baseInput());
    const v2 = m.proposeAcRefinement(r.id, 'AC-001', { description: 'X works (clarified)' }, 'ai-pm-1');
    assert.equal(v2.acceptanceCriteria[0].description, 'X works (clarified)');
    assert.equal(v2.acceptanceCriteria[0].version, 2);
  });
});

describe('G-03: VERIFIED_DELIVERY eligibility inside create (§16)', () => {
  it('VERIFIED_DELIVERY without a project category is rejected', () => {
    const m = mgr();
    assert.throws(
      () => m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        completionTargetAuthorization: HUMAN,
      })),
      (err: unknown) => {
        assert.ok(err instanceof VerifiedDeliveryRejectedError);
        assert.match(err.message, /projectCategory/);
        return true;
      },
    );
  });

  it('VERIFIED_DELIVERY for a production software project is rejected even with HUMAN authorization', () => {
    const m = mgr();
    assert.throws(
      () => m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        projectCategory: 'PRODUCTION_SOFTWARE',
        completionTargetAuthorization: HUMAN,
      })),
      VerifiedDeliveryRejectedError,
    );
  });

  it('VERIFIED_DELIVERY with an eligible category but no HUMAN authorization is rejected', () => {
    const m = mgr();
    assert.throws(
      () => m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        projectCategory: 'RESEARCH',
        releaseNaAuthorization: { authorizedBy: 'human-1', reason: 'docs only', at: '2026-10-10T00:00:00Z' },
      })),
      /HUMAN authorization/,
    );
  });

  it('VERIFIED_DELIVERY with a non-human authorization is rejected', () => {
    const m = mgr();
    assert.throws(
      () => m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        projectCategory: 'DEV_TOOL',
        completionTargetAuthorization: AI_AUTH,
      })),
      VerifiedDeliveryRejectedError,
    );
  });

  it('eligible category + HUMAN authorization succeeds and records the N/A basis', () => {
    const m = mgr();
    const r = m.create(baseInput({
      completionTarget: 'VERIFIED_DELIVERY',
      projectCategory: 'DOCUMENTATION',
      completionTargetAuthorization: HUMAN,
    }));
    assert.equal(r.versions[0].completionTarget, 'VERIFIED_DELIVERY');
    assert.equal(r.versions[0].projectCategory, 'DOCUMENTATION');
    // No explicit releaseNaAuthorization was passed: the HUMAN
    // authorization's basis is recorded as the N/A authorization.
    assert.equal(r.versions[0].releaseNaAuthorization?.authorizedBy, 'human-1');
    assert.equal(r.versions[0].releaseNaAuthorization?.reason, 'owner decision');
  });

  it('every §16-eligible category may declare VERIFIED_DELIVERY with HUMAN authorization', () => {
    const m = mgr();
    for (const projectCategory of ['DOCUMENTATION', 'RESEARCH', 'DEV_TOOL', 'NO_PRODUCTION_ENVIRONMENT'] as const) {
      const r = m.create(baseInput({
        completionTarget: 'VERIFIED_DELIVERY',
        projectCategory,
        completionTargetAuthorization: HUMAN,
      }));
      assert.equal(r.versions[0].completionTarget, 'VERIFIED_DELIVERY');
      assert.equal(r.versions[0].projectCategory, projectCategory);
    }
  });

  it('ordinary creates (RELEASED_OUTCOME / IMPLEMENTATION) need no category or authorization', () => {
    const m = mgr();
    const a = m.create(baseInput());
    assert.equal(a.versions[0].completionTarget, 'RELEASED_OUTCOME');
    const b = m.create(baseInput({ completionTarget: 'IMPLEMENTATION' }));
    assert.equal(b.versions[0].completionTarget, 'IMPLEMENTATION');
  });
});
