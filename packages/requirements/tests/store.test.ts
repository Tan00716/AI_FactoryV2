/**
 * RequirementStore seam (§16, F2) — the manager's persistence contract.
 *
 * The manager used to be process memory only: a restart lost every
 * requirement version and §16 compatibility declaration. It now takes
 * an optional store (mirroring the runtime OperationStore /
 * CheckpointStore seams), hydrates from it at construction, and writes
 * every mutation through. These tests pin, at the requirements layer:
 *
 *  - behavior parity: the same scripted sequence driven through a
 *    store-less manager and through one backed by
 *    InMemoryRequirementStore produces identical results at every
 *    step — including the error steps and auto-id sequence
 *    consumption;
 *  - restart shape: a second manager constructed over the same store
 *    answers exactly as the first one did (versions, links, holds,
 *    compatibility declarations) and continues the auto-id sequence;
 *  - copy contract: the in-memory store deep-copies in and out, so
 *    mutating a put argument or a read-back cannot corrupt it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRequirementStore,
  RequirementManager,
  type Requirement,
} from '../src/index';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function norm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(UUID_RE, '<uuid>'));
}

/** Deterministic clock: each manager gets an identical tick sequence. */
function tickClock(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

type Trace = Array<[string, unknown]>;

/** One identical scripted sequence, driven through any manager. */
function script(m: RequirementManager): Trace {
  const trace: Trace = [];
  const rec = (label: string, fn: () => unknown): void => {
    try {
      trace.push([label, norm(structuredClone(fn()))]);
    } catch (e) {
      // Error messages embed generated ids (hold UUIDs) — normalize
      // them through the same pass as returned values.
      trace.push([label, norm(`ERR: ${(e as Error).message}`)]);
    }
  };

  rec('create-explicit', () =>
    m.create({
      id: 'REQ-001',
      businessGoal: 'ship the feature',
      rationale: 'initial rationale',
      projectCategory: 'PRODUCTION_SOFTWARE',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'the feature works',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'INDEPENDENT_QA',
          expectedEvidence: 'qa_result with verdict PASS',
          applicableEnvironments: ['DEV'],
        },
        {
          id: 'AC-002',
          description: 'docs updated',
          verificationType: 'HUMAN_REVIEW',
          verifiedBy: 'HUMAN_OWNER',
          expectedEvidence: 'review record',
          applicableEnvironments: ['DEV'],
        },
      ],
      budget: { amount: 500, currency: 'USD' },
      createdBy: 'human',
    }),
  );
  // Auto-id parity: seq is consumed even by the colliding attempt, so
  // the first auto create throws (REQ-001 exists) and the second one
  // lands on REQ-002 — in BOTH the store-less and the stored manager.
  rec('create-auto-collides', () =>
    m.create({
      businessGoal: 'auto id attempt',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'x',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'CI',
          expectedEvidence: 'ci_result',
          applicableEnvironments: [],
        },
      ],
      createdBy: 'human',
    }),
  );
  rec('create-auto', () =>
    m.create({
      businessGoal: 'second requirement',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'y',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'CI',
          expectedEvidence: 'ci_result',
          applicableEnvironments: [],
        },
      ],
      createdBy: 'human',
    }).id,
  );
  rec('new-version', () =>
    m.newVersion('REQ-001', 'CORRECTION', 'fix rationale typo', 'human', (d) => {
      d.rationale = 'corrected rationale';
    }),
  );
  rec('ac-refinement', () =>
    m.proposeAcRefinement('REQ-001', 'AC-001', { description: 'the feature works end to end' }, 'pm-ai'),
  );
  rec('target-change-no-auth', () =>
    m.newVersion('REQ-001', 'TARGET_CHANGE', 'sneak the target', 'pm-ai', (d) => {
      d.completionTarget = 'IMPLEMENTATION';
    }),
  );
  rec('target-change-human', () =>
    m.changeCompletionTarget(
      'REQ-001',
      'IMPLEMENTATION',
      { authorizedBy: 'owner', isHuman: true, reason: 'scope agreed' },
      'owner',
    ),
  );
  rec('link', () => {
    m.linkEntities('REQ-001', 1, { taskIds: ['task-1'], evidenceIds: ['ev-1', 'ev-2'] });
    return m.getLinks('REQ-001', 1);
  });
  let holdId = '';
  rec('impact', () => {
    const impact = m.analyzeImpact('REQ-001', 1, 2, 'human');
    holdId = impact.suspendedPromotions[0]?.id ?? '';
    return impact;
  });
  rec('holds-active', () => m.activeHolds('task-1'));
  rec('promotion-gate', () => m.assertPromotionAllowed('task-1'));
  rec('compat-declare', () =>
    m.checkEvidenceCompatibility('ev-1', 'REQ-001', 2, true, 'ACs unchanged', 'human'),
  );
  rec('can-reuse', () => [
    m.canReuseEvidence('ev-1', 'REQ-001', 2),
    m.canReuseEvidence('ev-2', 'REQ-001', 2),
  ]);
  rec('release-hold', () => m.releaseHold(holdId, 'human', 're-validated against v2'));
  rec('promotion-gate-after', () => {
    m.assertPromotionAllowed('task-1');
    return 'allowed';
  });
  rec('get-version-1', () => m.getVersion('REQ-001', 1));
  rec('latest', () => m.latest('REQ-001'));
  rec('get-missing', () => m.get('REQ-999'));
  return trace;
}

describe('RequirementManager store seam (§16, F2)', () => {
  it('store-backed and store-less managers produce identical traces', () => {
    const bare = new RequirementManager({ now: tickClock() });
    const stored = new RequirementManager({
      now: tickClock(),
      store: new InMemoryRequirementStore(),
    });
    assert.deepEqual(script(stored), script(bare));
  });

  it('a second manager over the same store resumes exactly (restart shape)', () => {
    const store = new InMemoryRequirementStore();
    const first = new RequirementManager({ now: tickClock(), store });
    script(first);

    const second = new RequirementManager({ now: tickClock(), store });
    assert.deepEqual(second.get('REQ-001'), first.get('REQ-001'));
    assert.deepEqual(second.get('REQ-002'), first.get('REQ-002'));
    assert.deepEqual(second.getVersion('REQ-001', 1), first.getVersion('REQ-001', 1));
    assert.deepEqual(second.latest('REQ-001'), first.latest('REQ-001'));
    assert.deepEqual(second.getLinks('REQ-001', 1), first.getLinks('REQ-001', 1));
    assert.deepEqual(second.listHolds(), first.listHolds());
    assert.equal(second.canReuseEvidence('ev-1', 'REQ-001', 2), true);
    assert.equal(second.canReuseEvidence('ev-2', 'REQ-001', 2), false);
    // The auto-id sequence continues where the first manager left it:
    // REQ-001 explicit, REQ-002 auto (after one consumed collision) —
    // the next auto id is REQ-003, not a collision course with REQ-001.
    const next = second.create({
      businessGoal: 'after restart',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'z',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'CI',
          expectedEvidence: 'ci_result',
          applicableEnvironments: [],
        },
      ],
      createdBy: 'human',
    });
    assert.equal(next.id, 'REQ-003');
    // Writes through the resumed manager persist for a third one.
    const third = new RequirementManager({ store });
    assert.equal(third.get('REQ-003').id, 'REQ-003');
  });

  it('the in-memory store deep-copies in and out', () => {
    const store = new InMemoryRequirementStore();
    const m = new RequirementManager({ store });
    const req = m.create({
      id: 'REQ-100',
      businessGoal: 'copy contract',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'x',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'CI',
          expectedEvidence: 'ci_result',
          applicableEnvironments: [],
        },
      ],
      createdBy: 'human',
    });
    // Mutating the manager's live object after the put must not leak
    // into the stored snapshot (the next put is what updates it).
    req.versions[0]!.businessGoal = 'tampered';
    assert.equal(store.listRequirements()[0]!.versions[0]!.businessGoal, 'copy contract');
    // Mutating a read-back must not corrupt the store either.
    const back = store.listRequirements()[0]! as Requirement;
    back.versions.length = 0;
    assert.equal(store.listRequirements()[0]!.versions.length, 1);
  });
});
