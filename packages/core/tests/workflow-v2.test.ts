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
    const s = e.get('t-1');
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
    e.get('t-1').stage = 'OUTCOME_VERIFICATION';
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
    e.get('t-1').stage = 'OUTCOME_VERIFICATION';
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
    e.get('t-1').stage = 'OUTCOME_VERIFICATION';
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
