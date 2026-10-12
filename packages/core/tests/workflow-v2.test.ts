/**
 * Tests for the v2 workflow state machine (SPEC_V2 §18) and engine (§19, §20.1):
 * three-state separation, reason-code denials, finalize transaction,
 * rollback, and COMPLETION_INVALIDATED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  DEFAULT_TRANSITIONS_V2,
  Evidence,
  GateContext,
  WORKFLOW_STAGES,
  WorkflowEngineV2,
  WorkflowStage,
  allowedNextStages,
  checkTransitionV2,
  isReasonCode,
} from '../src/index';

function ev(id: string, type: Evidence['type'], verdict?: string): Evidence {
  return {
    id, taskId: 't-1', type, title: id,
    payload: verdict ? { verdict } : {},
    status: 'DRAFT', createdBy: 'tester',
    createdAt: '2026-10-10T00:00:00.000Z', sealedAt: null,
  };
}

function baseCtx(over: Partial<GateContext> & { idempotencyKey?: string; blockReason?: string } = {}): GateContext & { idempotencyKey?: string; blockReason?: string } {
  return {
    taskId: 't-1',
    taskVersion: 1,
    actor: 'agent-1',
    authorization: { status: 'AUTHORIZED', expiresAt: null },
    requirementVersion: 'REQ-001@1',
    candidateDigest: 'sha256:abc',
    implementerId: 'coder-1',
    evidence: [],
    evidenceReqVersions: {},
    staleEvidenceIds: [],
    budgetOk: true,
    quotaOk: true,
    confinementOk: true,
    dependenciesReady: true,
    ...over,
  };
}

function engine() {
  return new WorkflowEngineV2({ audit: new AuditLog(), now: () => 1700000000000 });
}

describe('v2 state model (§18.1/§18.3/§19)', () => {
  it('has exactly the 13 spec stages, including OUTCOME_VERIFICATION', () => {
    assert.deepEqual([...WORKFLOW_STAGES], [
      'TODO', 'PLANNING', 'IN_PROGRESS', 'CODE_REVIEW', 'PENDING_QA', 'QA',
      'PENDING_UAT_MERGE', 'UAT', 'PENDING_PROD', 'PROD_DEPLOYING',
      'PROD_VERIFICATION', 'OUTCOME_VERIFICATION', 'DONE',
    ]);
  });

  it('every non-terminal stage has at least one outgoing edge (generated from the table)', () => {
    for (const s of WORKFLOW_STAGES) {
      const edges = allowedNextStages(s);
      if (s === 'DONE') assert.equal(edges.length, 0);
      else assert.ok(edges.length > 0, `${s} has no outgoing edges`);
    }
  });

  it('all denial reason codes are among the 16 machine codes', () => {
    for (const s of WORKFLOW_STAGES) {
      for (const e of DEFAULT_TRANSITIONS_V2[s]) {
        for (const p of e.gatePredicates) assert.ok(isReasonCode(p.reasonCode), p.reasonCode);
      }
    }
  });

  it('registers with separated stage/condition/milestones', () => {
    const e = engine();
    const s = e.register('t-1', { requirementRef: 'REQ-001@1' });
    assert.equal(s.stage, 'TODO');
    assert.equal(s.condition.condition, 'ACTIVE');
    assert.equal(s.milestones.IMPLEMENTED.achieved, false);
    assert.equal(s.releaseState, 'NONE');
    assert.equal(s.finalSeal, 0);
    assert.equal(s.taskVersion, 1);
  });
});

describe('checkTransitionV2 denials (§18.2)', () => {
  it('illegal jump TODO→DONE is denied with POLICY_DENIED', () => {
    const r = checkTransitionV2('TODO', 'DONE', baseCtx());
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'POLICY_DENIED');
    assert.match(r.missing[0], /Illegal jump/);
  });

  it('stale expectedTaskVersion → VERSION_CONFLICT (concurrent old request)', () => {
    const r = checkTransitionV2('TODO', 'PLANNING', baseCtx({ expectedTaskVersion: 3 }));
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'VERSION_CONFLICT');
  });

  it('missing evidence → MISSING_EVIDENCE naming the gap', () => {
    const r = checkTransitionV2('PLANNING', 'IN_PROGRESS', baseCtx());
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'MISSING_EVIDENCE');
    assert.ok(r.missing.some((m) => m.includes('Planning artifact')));
  });

  it('stale evidence → STALE_EVIDENCE', () => {
    const plan = ev('ev-plan', 'plan');
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({ evidence: [plan], staleEvidenceIds: ['ev-plan'] }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'STALE_EVIDENCE');
  });

  it('evidence from an older requirement version → STALE_EVIDENCE', () => {
    const plan = ev('ev-plan', 'plan');
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({
        evidence: [plan],
        requirementVersion: 'REQ-001@2',
        evidenceReqVersions: { 'ev-plan': 'REQ-001@1' },
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'STALE_EVIDENCE');
  });

  it('expired authorization → AUTHORIZATION_EXPIRED', () => {
    const r = checkTransitionV2(
      'TODO', 'PLANNING',
      baseCtx({ authorization: { status: 'AUTHORIZED', expiresAt: '2020-01-01T00:00:00.000Z' } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'AUTHORIZATION_EXPIRED');
  });

  it('revoked authorization → AUTHORIZATION_EXPIRED', () => {
    const r = checkTransitionV2(
      'TODO', 'PLANNING',
      baseCtx({ authorization: { status: 'REVOKED', expiresAt: null } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'AUTHORIZATION_EXPIRED');
  });

  it('budget exceeded → BUDGET_EXCEEDED', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({ evidence: [ev('ev-plan', 'plan')], budgetOk: false }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'BUDGET_EXCEEDED');
  });

  it('self-review acceptance → INDEPENDENCE_REQUIRED', () => {
    const r = checkTransitionV2(
      'CODE_REVIEW', 'PENDING_QA',
      baseCtx({
        actor: 'coder-1',
        evidence: [ev('ev-review', 'code_review', 'PASS')],
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'INDEPENDENCE_REQUIRED');
  });

  it('unpinned requirement → POLICY_DENIED', () => {
    const r = checkTransitionV2('TODO', 'PLANNING', baseCtx({ requirementVersion: null }));
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'POLICY_DENIED');
  });

  it('prod deploy without approval evidence → APPROVAL_REQUIRED', () => {
    const r = checkTransitionV2('PENDING_PROD', 'PROD_DEPLOYING', baseCtx());
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'APPROVAL_REQUIRED');
  });
});

describe('checkTransitionV2 §16 explicit compatibility exemption', () => {
  // Evidence collected against REQ-001@1, task now pinned at REQ-001@2:
  // the classic post-bump reuse situation §16 governs.
  const plan = ev('ev-plan', 'plan');
  const bumped = {
    evidence: [plan],
    requirementVersion: 'REQ-001@2',
    evidenceReqVersions: { 'ev-plan': 'REQ-001@1' },
  };

  it('version mismatch + evidence in the compatible set → allowed', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({ ...bumped, compatibleEvidenceIds: new Set(['ev-plan']) }),
    );
    assert.equal(r.ok, true);
  });

  it('version mismatch + compatible set names only OTHER evidence → still STALE_EVIDENCE', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({ ...bumped, compatibleEvidenceIds: new Set(['ev-other']) }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'STALE_EVIDENCE');
  });

  it('version mismatch + empty compatible set → still STALE_EVIDENCE', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({ ...bumped, compatibleEvidenceIds: new Set() }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'STALE_EVIDENCE');
  });

  it('version match + evidence in the compatible set → allowed (no distortion)', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({
        evidence: [plan],
        requirementVersion: 'REQ-001@1',
        evidenceReqVersions: { 'ev-plan': 'REQ-001@1' },
        compatibleEvidenceIds: new Set(['ev-plan']),
      }),
    );
    assert.equal(r.ok, true);
  });

  it('compatible set does NOT exempt the explicit staleEvidenceIds list', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({
        ...bumped,
        staleEvidenceIds: ['ev-plan'],
        compatibleEvidenceIds: new Set(['ev-plan']),
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reasonCode, 'STALE_EVIDENCE');
      // Denied by the explicit-stale branch, not the version branch.
      assert.match(r.missing[0], /is stale/);
    }
  });

  it('compatible set does NOT wave other gates through (budget still denies)', () => {
    const r = checkTransitionV2(
      'PLANNING', 'IN_PROGRESS',
      baseCtx({
        ...bumped,
        compatibleEvidenceIds: new Set(['ev-plan']),
        budgetOk: false,
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'BUDGET_EXCEEDED');
  });
});

describe('WorkflowEngineV2', () => {
  it('legal transition moves the stage and bumps the version', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    assert.equal(r.ok, true);
    assert.equal(e.get('t-1').stage, 'PLANNING');
    assert.equal(e.get('t-1').taskVersion, 2);
  });

  it('duplicate events are deduped via idempotencyKey (no double mutation)', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const ctx = baseCtx({ idempotencyKey: 'evt-123' });
    const r1 = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx);
    const r2 = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx);
    assert.equal(r1.ok, true);
    assert.equal((r2 as { deduped?: boolean }).deduped, true);
    assert.equal(e.get('t-1').taskVersion, 2); // bumped once
  });

  it('direct DONE transition is refused — finalize() is the only path', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'DONE', 'agent-1', baseCtx());
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'POLICY_DENIED');
    assert.match(r.missing[0], /finalize/);
  });

  it('unknown intent → UNSUPPORTED_CAPABILITY', () => {
    const e = engine();
    e.register('t-1');
    const r = e.requestIntent('t-1', 'FLY_TO_MOON', 'agent-1', baseCtx());
    assert.equal(r.ok, false);
    assert.equal((r as { reasonCode?: string }).reasonCode, 'UNSUPPORTED_CAPABILITY');
  });

  it('REPORT_BLOCKED sets the condition with reason/resume/blocked_on', () => {
    const e = engine();
    e.register('t-1');
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    e.requestIntent('t-1', 'REPORT_BLOCKED', 'agent-1',
      baseCtx({ blockReason: 'waiting on API spec' }));
    const c = e.get('t-1').condition;
    assert.equal(c.condition, 'BLOCKED');
    assert.equal(c.reason, 'waiting on API spec');
    assert.equal(c.resumeState, 'PLANNING');
  });

  const goodSnapshot = {
    applicableAcs: [{ id: 'AC-001', verified: true }],
    gatesValid: true,
    milestonesValid: true,
    pendingBlocks: [],
    authorizationsComplete: true,
    releaseApplicable: true,
    releaseNaAuthorized: false,
  };

  it('finalize(): predicates checked, then DONE + final_seal=1 in one transaction', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    // drive to OUTCOME_VERIFICATION via direct stage walk for the test
    for (const to of ['PLANNING'] as WorkflowStage[]) {
      e.requestTransitionV2('t-1', to, 'agent-1', baseCtx());
    }
    // (test-only shortcut: walk remaining stages without gates)
    const s = e.getMutable('t-1');
    s.stage = 'OUTCOME_VERIFICATION';
    const r = e.finalize('t-1', 'agent-1', goodSnapshot);
    assert.equal(r.ok, true);
    const after = e.get('t-1');
    assert.equal(after.stage, 'DONE');
    assert.equal(after.finalSeal, 1);
    assert.equal(after.milestones.DONE.achieved, true);
    assert.ok(after.completionHistory.some((h) => h.kind === 'COMPLETED'));
  });

  it('finalize() denial leaves state untouched (no partial commit)', () => {
    const e = engine();
    e.register('t-1');
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    const before = e.get('t-1').taskVersion;
    const r = e.finalize('t-1', 'agent-1', {
      ...goodSnapshot,
      applicableAcs: [{ id: 'AC-001', verified: false }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'MISSING_EVIDENCE');
    const after = e.get('t-1');
    assert.equal(after.stage, 'OUTCOME_VERIFICATION');
    assert.equal(after.finalSeal, 0);
    assert.equal(after.taskVersion, before);
  });

  it('finalize() refused when condition is not ACTIVE', () => {
    const e = engine();
    e.register('t-1');
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    e.setCondition('t-1', 'BLOCKED', 'x', 'agent-1');
    const r = e.finalize('t-1', 'agent-1', goodSnapshot);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'POLICY_DENIED');
  });

  it('rollback: RELEASED history kept, current state ROLLED_BACK, outcome gate invalid', () => {
    const e = engine();
    e.register('t-1');
    e.recordRelease('t-1', 'release-bot', 'v1.2.0 deployed');
    assert.equal(e.get('t-1').releaseState, 'RELEASED');
    e.recordRollback('t-1', 'release-bot', 'smoke regression');
    const s = e.get('t-1');
    assert.equal(s.releaseState, 'ROLLED_BACK');
    assert.ok(s.releaseHistory.some((h) => h.state === 'RELEASED'));
    assert.ok(s.releaseHistory.some((h) => h.state === 'ROLLED_BACK'));
    assert.equal(s.outcomeGateValid, false);
    assert.equal(s.milestones.RELEASED.achieved, true); // history preserved
  });

  it('invalidateCompletion(): COMPLETION_INVALIDATED appended, history not rewritten', () => {
    const e = engine();
    e.register('t-1');
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    const fr = e.finalize('t-1', 'agent-1', goodSnapshot);
    assert.equal(fr.ok, true);
    e.invalidateCompletion('t-1', 'human-1', 'regression found in prod');
    const s = e.get('t-1');
    assert.equal(s.stage, 'IN_PROGRESS');
    assert.equal(s.finalSeal, 0);
    assert.equal(s.condition.condition, 'REWORK');
    assert.ok(s.completionHistory.some((h) => h.kind === 'COMPLETION_INVALIDATED'));
    // The earlier DONE is still in history, marked invalidated — not deleted.
    const doneHist = s.milestoneHistory.find((h) => h.milestone === 'DONE');
    assert.ok(doneHist && doneHist.invalidatedAt !== undefined);
    assert.equal(s.milestones.DONE.achieved, false);
  });
});

describe('WorkflowEngineV2 §18.2 read barrier', () => {
  it('get() returns a deep-frozen snapshot: top-level mutation throws', () => {
    const e = engine();
    e.register('t-1');
    const s = e.get('t-1');
    assert.throws(() => {
      (s as { stage: unknown }).stage = 'DONE';
    }, TypeError);
    assert.equal(e.get('t-1').stage, 'TODO');
  });

  it('get() returns a deep-frozen snapshot: nested mutation throws', () => {
    const e = engine();
    e.register('t-1');
    const s = e.get('t-1');
    assert.throws(() => {
      (s.milestones.DONE as { achieved: boolean }).achieved = true;
    }, TypeError);
    assert.throws(() => {
      (s.condition as { condition: string }).condition = 'BLOCKED';
    }, TypeError);
    assert.equal(e.get('t-1').milestones.DONE.achieved, false);
  });

  it('get() returns a copy: engine state is unaffected by the snapshot', () => {
    const e = engine();
    e.register('t-1');
    const a = e.get('t-1');
    const b = e.get('t-1');
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it('getMutable() still returns the live reference for engine/test setup use', () => {
    const e = engine();
    e.register('t-1');
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    assert.equal(e.get('t-1').stage, 'OUTCOME_VERIFICATION');
  });

  it('get() on an unknown task still throws', () => {
    const e = engine();
    assert.throws(() => e.get('nope'), /Unknown task/);
  });
});

describe('TransitionDefV2 optional §18.2 fields (additive)', () => {
  it('accepts escalation and evidenceInvalidationRules without breaking checks', () => {
    const def = {
      intent: 'TEST_INTENT',
      to: 'DONE',
      entryConditions: [],
      requiredEvidence: [],
      gatePredicates: [],
      failureConditions: [],
      note: 'test edge',
      escalation: { target: 'human', afterMs: 3_600_000, reason: 'stuck too long' },
      evidenceInvalidationRules: [
        { evidenceTypes: ['qa_result'], scope: 'stale-version', reason: 'new code' },
      ],
    } as const;
    // Structural: the optional fields are carried on the def.
    assert.equal(def.escalation?.target, 'human');
    assert.equal(def.evidenceInvalidationRules?.[0].scope, 'stale-version');
    // Behavioral: existing transition defs are unaffected by the addition.
    const edge = DEFAULT_TRANSITIONS_V2['TODO']?.[0];
    assert.ok(edge);
  });

  it('defs without the new fields still satisfy the interface', () => {
    for (const edges of Object.values(DEFAULT_TRANSITIONS_V2)) {
      for (const e of edges) {
        assert.ok(e.escalation === undefined || typeof e.escalation === 'object');
        assert.ok(e.evidenceInvalidationRules === undefined || Array.isArray(e.evidenceInvalidationRules));
      }
    }
  });
});

describe('cancelTask (B-G-22)', () => {
  it('sets condition CANCELLED, appends history, and audits', () => {
    const audit = new AuditLog();
    const e = new WorkflowEngineV2({ audit, now: () => 1700000000000 });
    e.register('t-cancel');
    const out = e.cancelTask('t-cancel', 'human:alice', 'no longer needed');
    assert.equal(out.condition.condition, 'CANCELLED');
    assert.equal(out.condition.reason, 'no longer needed');
    assert.equal(out.condition.updatedBy, 'human:alice');
    // Stage untouched (§18.3 three-state separation).
    assert.equal(out.stage, 'TODO');
    const last = out.completionHistory[out.completionHistory.length - 1];
    assert.equal(last.kind, 'CANCELLED');
    const events = audit.list().filter((r) => r.entityId === 't-cancel').map((r) => r.action);
    assert.ok(events.includes('TASK_CANCELLED'));
  });

  it('is idempotent on an already-cancelled task', () => {
    const audit = new AuditLog();
    const e = new WorkflowEngineV2({ audit, now: () => 1700000000000 });
    e.register('t-cancel-2');
    e.cancelTask('t-cancel-2', 'human:alice', 'first');
    const again = e.cancelTask('t-cancel-2', 'human:alice', 'second');
    assert.equal(
      again.completionHistory.filter((h) => h.kind === 'CANCELLED').length,
      1,
    );
  });

  it('best-effort releases leases; release failures are audited, not fatal', () => {
    const audit = new AuditLog();
    let releasedFor: string | null = null;
    const e = new WorkflowEngineV2({
      audit,
      now: () => 1700000000000,
      releaseLeases: (taskId) => {
        releasedFor = taskId;
        return 2;
      },
    });
    e.register('t-cancel-3');
    const out = e.cancelTask('t-cancel-3', 'human:alice', 'done');
    assert.equal(releasedFor, 't-cancel-3');
    assert.equal(out.condition.condition, 'CANCELLED');

    const audit2 = new AuditLog();
    const e2 = new WorkflowEngineV2({
      audit: audit2,
      now: () => 1700000000000,
      releaseLeases: () => {
        throw new Error('lease store down');
      },
    });
    e2.register('t-cancel-4');
    const out2 = e2.cancelTask('t-cancel-4', 'human:alice', 'done');
    assert.equal(out2.condition.condition, 'CANCELLED');
    const actions = audit2.list().filter((r) => r.entityId === 't-cancel-4').map((r) => r.action);
    assert.ok(actions.includes('TASK_CANCEL_LEASE_RELEASE_FAILED'));
    assert.ok(actions.includes('TASK_CANCELLED'));
  });

  it('throws for an unknown task', () => {
    const e = engine();
    assert.throws(() => e.cancelTask('nope', 'human:alice', 'x'), /Unknown task/);
  });
});

describe('Batch 4 · G-16 lease gate predicate', () => {
  const submitCtx = (over: Partial<GateContext> = {}) =>
    baseCtx({ evidence: [ev('ev-cc', 'code_change')], ...over });

  it('IN_PROGRESS→CODE_REVIEW without a lease attestation is denied (fail-closed)', () => {
    const r = checkTransitionV2('IN_PROGRESS', 'CODE_REVIEW', submitCtx());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reasonCode, 'STALE_OWNER');
      assert.ok(r.missing.some((m) => m.includes('[lease-valid]')));
    }
  });

  it('IN_PROGRESS→CODE_REVIEW with leaseValid=false is denied', () => {
    const r = checkTransitionV2('IN_PROGRESS', 'CODE_REVIEW', submitCtx({ leaseValid: false }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'STALE_OWNER');
  });

  it('IN_PROGRESS→CODE_REVIEW with leaseValid=true passes', () => {
    const r = checkTransitionV2(
      'IN_PROGRESS', 'CODE_REVIEW',
      submitCtx({ leaseValid: true, leaseId: 'lease-1' }),
    );
    assert.equal(r.ok, true);
  });

  it('PROD_DEPLOYING→PROD_VERIFICATION is lease-gated too', () => {
    const prodCtx = (over: Partial<GateContext> = {}) =>
      baseCtx({ evidence: [ev('ev-dep', 'deployment')], ...over });
    const denied = checkTransitionV2('PROD_DEPLOYING', 'PROD_VERIFICATION', prodCtx());
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reasonCode, 'STALE_OWNER');
    const ok = checkTransitionV2(
      'PROD_DEPLOYING', 'PROD_VERIFICATION', prodCtx({ leaseValid: true }),
    );
    assert.equal(ok.ok, true);
  });

  it('edges without a lease entry condition do not require leaseValid', () => {
    // TODO→PLANNING has no lease in its entry conditions: unchanged behavior.
    const r = checkTransitionV2('TODO', 'PLANNING', baseCtx());
    assert.equal(r.ok, true);
  });

  it('the lease predicate is attached exactly to the lease-mentioning edges', () => {
    const hasLease = (from: WorkflowStage, to: WorkflowStage) =>
      (DEFAULT_TRANSITIONS_V2[from] ?? [])
        .find((e) => e.to === to)
        ?.gatePredicates.some((p) => p.id === 'lease-valid');
    assert.equal(hasLease('IN_PROGRESS', 'CODE_REVIEW'), true);
    assert.equal(hasLease('PROD_DEPLOYING', 'PROD_VERIFICATION'), true);
    assert.equal(hasLease('TODO', 'PLANNING'), false);
    assert.equal(hasLease('PLANNING', 'IN_PROGRESS'), false);
    assert.equal(hasLease('QA', 'PENDING_UAT_MERGE'), false);
    assert.equal(hasLease('PROD_VERIFICATION', 'OUTCOME_VERIFICATION'), false);
  });
});

describe('Batch 4 · G-17 transition outbox', () => {
  it('a committed transition appends exactly one outbox event', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    assert.equal(r.ok, true);
    const out = e.listOutbox();
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      taskId: 't-1',
      from: 'TODO',
      to: 'PLANNING',
      by: 'agent-1',
      at: '2023-11-14T22:13:20.000Z', // fixed clock 1700000000000
      intent: 'START_TASK',
    });
  });

  it('denied transitions emit nothing', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'DONE', 'agent-1', baseCtx());
    assert.equal(r.ok, false);
    assert.equal(e.listOutbox().length, 0);
  });

  it('an idempotency-deduped repeat does not emit a second event', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const ctx = baseCtx({ idempotencyKey: 'evt-ob-1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx);
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx);
    assert.equal(e.listOutbox().length, 1);
  });

  it('listOutbox filters by task and returns copies', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.register('t-2', { requirementRef: 'REQ-001@1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    e.requestTransitionV2('t-2', 'PLANNING', 'agent-9', baseCtx({ taskId: 't-2', actor: 'agent-9' }));
    assert.equal(e.listOutbox().length, 2);
    const only1 = e.listOutbox('t-1');
    assert.equal(only1.length, 1);
    assert.equal(only1[0].taskId, 't-1');
    // Returned events are copies: mutating one cannot corrupt the queue.
    only1[0].to = 'DONE';
    assert.equal(e.listOutbox('t-1')[0].to, 'PLANNING');
  });

  it('drainOutbox returns and clears; a second drain is empty', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    const drained = e.drainOutbox();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].to, 'PLANNING');
    assert.equal(e.listOutbox().length, 0);
    assert.equal(e.drainOutbox().length, 0);
  });

  it('drainOutbox(taskId) drains only that task', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.register('t-2', { requirementRef: 'REQ-001@1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    e.requestTransitionV2('t-2', 'PLANNING', 'agent-1', baseCtx({ taskId: 't-2' }));
    const drained = e.drainOutbox('t-1');
    assert.equal(drained.length, 1);
    assert.equal(e.listOutbox().length, 1);
    assert.equal(e.listOutbox()[0].taskId, 't-2');
  });

  const finalizeSnapshot = {
    applicableAcs: [{ id: 'AC-001', verified: true }],
    gatesValid: true,
    milestonesValid: true,
    pendingBlocks: [] as string[],
    authorizationsComplete: true,
    releaseApplicable: true,
    releaseNaAuthorized: false,
  };

  it('finalize() emits a DONE outbox event; a denied finalize emits none', () => {
    const e = engine();
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    const denied = e.finalize('t-1', 'agent-1', {
      ...finalizeSnapshot,
      applicableAcs: [{ id: 'AC-001', verified: false }],
    });
    assert.equal(denied.ok, false);
    assert.equal(e.listOutbox().length, 0);
    const ok = e.finalize('t-1', 'agent-1', finalizeSnapshot);
    assert.equal(ok.ok, true);
    const out = e.listOutbox();
    assert.equal(out.length, 1);
    assert.equal(out[0].from, 'OUTCOME_VERIFICATION');
    assert.equal(out[0].to, 'DONE');
    assert.equal(out[0].intent, 'REQUEST_COMPLETE');
    assert.equal(out[0].by, 'agent-1');
  });
});

describe('Batch 4 · G-21 failure events', () => {
  it('setCondition to FAILED records a failure event with full context', () => {
    const e = engine();
    e.register('t-1');
    e.getMutable('t-1').stage = 'QA';
    e.setCondition('t-1', 'FAILED', 'qa verdict FAIL on candidate', 'qa-bot');
    const evs = e.listFailureEvents();
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0], {
      taskId: 't-1',
      condition: 'FAILED',
      previousCondition: 'ACTIVE',
      stage: 'QA',
      reason: 'qa verdict FAIL on candidate',
      by: 'qa-bot',
      at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('non-failure conditions record no failure event', () => {
    const e = engine();
    e.register('t-1');
    e.setCondition('t-1', 'BLOCKED', 'waiting', 'agent-1');
    e.setCondition('t-1', 'REWORK', 'changes requested', 'agent-1');
    e.setCondition('t-1', 'ACTIVE', 'resumed', 'agent-1');
    assert.equal(e.listFailureEvents().length, 0);
  });

  it('re-setting FAILED records a new event with previousCondition FAILED', () => {
    const e = engine();
    e.register('t-1');
    e.setCondition('t-1', 'FAILED', 'first failure', 'qa-bot');
    e.setCondition('t-1', 'FAILED', 'failed again after retry', 'qa-bot');
    const evs = e.listFailureEvents('t-1');
    assert.equal(evs.length, 2);
    assert.equal(evs[1].previousCondition, 'FAILED');
    assert.equal(evs[1].reason, 'failed again after retry');
  });

  it('listFailureEvents filters by task; unknown task yields []', () => {
    const e = engine();
    e.register('t-1');
    e.register('t-2');
    e.setCondition('t-2', 'FAILED', 'boom', 'agent-1');
    assert.equal(e.listFailureEvents('t-1').length, 0);
    assert.equal(e.listFailureEvents('t-2').length, 1);
    assert.equal(e.listFailureEvents('nope').length, 0);
    // Copies: mutating a returned event cannot corrupt the log.
    const evs = e.listFailureEvents('t-2');
    evs[0].reason = 'tampered';
    assert.equal(e.listFailureEvents('t-2')[0].reason, 'boom');
  });

  it('cancelTask / invalidateCompletion do not create failure events', () => {
    const e = engine();
    e.register('t-1');
    e.cancelTask('t-1', 'human-1', 'dropped');
    assert.equal(e.listFailureEvents().length, 0);
  });
});
