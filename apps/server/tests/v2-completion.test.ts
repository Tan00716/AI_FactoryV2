/**
 * v2 completion + evidence sealing — Batch 12 (walkthrough findings
 * F1 + F3).
 *
 * F1: POST /api/tasks/:id/v2-complete exposes WorkflowEngineV2.finalize()
 * over HTTP. The service assembles the §20.1 CompletionSnapshot from
 * server-side facts (pinned requirement's ACs judged against recorded
 * evidence, recorded milestones, dependency/approval facts, engine
 * outcome-gate validity) — the predicates genuinely bind: an unverified
 * AC, a PENDING approval, or an unfinished dependency each deny
 * completion with the DB row untouched. On success DONE + final_seal=1
 * commit and the v2 mirror agrees with the DB row. v2-transition to
 * DONE stays 422 by engine design.
 *
 * F3: the engine's onSealEvidence hook is wired to EvidenceEngine.seal —
 * evidence a gate consumes becomes SEALED (immutable) when the
 * transition commits; a denied transition seals nothing; evidence a
 * gate merely inspects via a predicate (the production approval) is
 * NOT sealed.
 *
 * Like v2-transitions.test.ts this runs against the compiled dist and
 * requires `npm run build -w @ai-factory/server` first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import type { Evidence } from '@ai-factory/core';
import { RequirementManager } from '@ai-factory/requirements';
import {
  createV2TransitionService,
  handleV2TransitionRoutes,
} from '../dist/routes/v2-transitions.js';
import type { V2TransitionService } from '../dist/routes/v2-transitions.js';
import { getRequirementManager } from '../dist/routes/requirements.js';

// ------------------------------------------------------------ fixtures --

const EVIDENCE_PLAN: Array<[string, Record<string, unknown>]> = [
  ['plan', {}],
  ['code_change', { sha: 'cand-1' }],
  ['code_review', { verdict: 'PASS' }],
  ['ci_result', { verdict: 'PASS' }],
  ['qa_result', { verdict: 'PASS' }],
  ['security_report', { verdict: 'PASS' }],
  ['merge', { pr: 'PR-1' }],
  ['uat_result', { verdict: 'PASS' }],
  ['approval', { verdict: 'APPROVED' }],
  ['deployment', { environment: 'prod', digest: 'cand-1' }],
  ['smoke_test', { verdict: 'PASS' }],
];

function seedEvidence(
  evidence: EvidenceEngine,
  taskId: string,
  pin?: string,
): Map<string, Evidence> {
  const byType = new Map<string, Evidence>();
  for (const [type, payload] of EVIDENCE_PLAN) {
    const ev = evidence.create({
      taskId,
      type: type as Evidence['type'],
      title: `${type} (completion test)`,
      payload,
      createdBy: 'human',
      requirementVersion: type === 'plan' && pin ? pin : null,
    });
    byType.set(type, ev);
  }
  return byType;
}

/** Walk a task from TODO to OUTCOME_VERIFICATION through every v2 gate. */
function walkToOutcomeVerification(
  service: V2TransitionService,
  taskId: string,
  pin: string,
): void {
  const t = (to: Parameters<V2TransitionService['transition']>[1], extra: Record<string, unknown> = {}) => {
    const r = service.transition(taskId, to, 'human', {
      requirementVersion: pin,
      ...extra,
    });
    assert.equal(r.ok, true, `walk → ${to}: ${JSON.stringify(r)}`);
  };
  t('PLANNING');
  t('IN_PROGRESS', { budgetOk: true });
  t('CODE_REVIEW', {
    candidateDigest: 'cand-1',
    confinementOk: true,
    leaseValid: true,
    leaseId: 'lease-1',
    implementerId: 'agent-1',
  });
  t('PENDING_QA', { implementerId: 'agent-1' });
  t('QA', { quotaOk: true });
  t('PENDING_UAT_MERGE');
  t('UAT', { candidateDigest: 'cand-1' });
  t('PENDING_PROD');
  t('PROD_DEPLOYING');
  t('PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-2' });
  t('OUTCOME_VERIFICATION');
}

function makeManager(acExtra: Array<Record<string, unknown>> = []): RequirementManager {
  const mgr = new RequirementManager();
  mgr.create({
    id: 'REQ-001',
    businessGoal: 'ship the thing',
    acceptanceCriteria: [
      {
        id: 'AC-001',
        description: 'the thing works',
        verificationType: 'AUTOMATED_TEST',
        verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result with verdict PASS',
        applicableEnvironments: ['DEV'],
      },
      ...acExtra,
    ] as never,
    createdBy: 'human',
  });
  return mgr;
}

function makeService(deps: {
  requirements?: RequirementManager;
  approvals?: { listByTask(taskId: string): ReadonlyArray<{ status: string }> };
} = {}) {
  const tasks = new TaskManager();
  const evidence = new EvidenceEngine();
  const audit = new AuditLog();
  const service = createV2TransitionService({
    tasks,
    evidence,
    audit,
    requirements: deps.requirements,
    approvals: deps.approvals,
  });
  const taskId = tasks.create({ projectId: 'p1', title: 'completion target', creator: 'human' }).id;
  return { tasks, evidence, audit, service, taskId };
}

// ------------------------------------------------------- route level --

const rTasks = new TaskManager();
const rEvidence = new EvidenceEngine();
const rAudit = new AuditLog();

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      tasks: rTasks,
      evidence: rEvidence,
      audit: rAudit,
      bus: { emit: () => {} },
      readBody: async () => body,
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
    } as never,
    calls,
  };
}

async function call(method: string, path: string, body: Record<string, unknown> = {}) {
  const { ctx, calls } = makeCtx(body);
  const handled = await handleV2TransitionRoutes(
    { method } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

describe('v2 completion routes (§20.1, F1)', () => {
  it('POST /v2-complete completes a fully-gated task: DONE + finalSeal 1, mirror and DB agree', async () => {
    // Seed the shared requirements manager so the pinned version's ACs
    // genuinely bind the completion check (AC-001 ↔ qa_result PASS).
    const mgr = getRequirementManager();
    mgr.create({
      id: 'REQ-RTE',
      businessGoal: 'route-level completion',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'the thing works',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'INDEPENDENT_QA',
          expectedEvidence: 'qa_result with verdict PASS',
          applicableEnvironments: ['DEV'],
        },
      ],
      createdBy: 'human',
    } as never);

    const taskId = rTasks.create({ projectId: 'p1', title: 'route completion', creator: 'human' }).id;
    seedEvidence(rEvidence, taskId, 'REQ-RTE@1');
    const pin = 'REQ-RTE@1';
    const advance = async (toState: string, extra: Record<string, unknown> = {}) => {
      const r = await call('POST', `/api/tasks/${taskId}/v2-transition`, {
        toState, by: 'human', requirementVersion: pin, ...extra,
      });
      assert.equal(r.status, 200, `→ ${toState}: ${JSON.stringify(r.body)}`);
    };
    await advance('PLANNING');
    await advance('IN_PROGRESS', { budgetOk: true });
    await advance('CODE_REVIEW', {
      candidateDigest: 'cand-1', confinementOk: true,
      leaseValid: true, leaseId: 'lease-1', implementerId: 'agent-1',
    });
    await advance('PENDING_QA', { implementerId: 'agent-1' });
    await advance('QA', { quotaOk: true });
    await advance('PENDING_UAT_MERGE');
    await advance('UAT', { candidateDigest: 'cand-1' });
    await advance('PENDING_PROD');
    await advance('PROD_DEPLOYING');
    await advance('PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-2' });
    await advance('OUTCOME_VERIFICATION');

    const r = await call('POST', `/api/tasks/${taskId}/v2-complete`, { by: 'human' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as {
      ok: boolean;
      finalSeal: number;
      warnings: string[];
      snapshot: {
        applicableAcs: Array<{ id: string; verified: boolean }>;
        gatesValid: boolean;
        milestonesValid: boolean;
        pendingBlocks: string[];
        authorizationsComplete: boolean;
        releaseApplicable: boolean;
      };
      state: {
        stage: string;
        finalSeal: number;
        dbStatus: string;
        milestones: Record<string, { achieved: boolean }>;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.finalSeal, 1);
    assert.deepEqual(body.warnings, []);
    // The snapshot was assembled from real facts, and every predicate held.
    assert.deepEqual(body.snapshot.applicableAcs, [{ id: 'AC-001', verified: true }]);
    assert.equal(body.snapshot.gatesValid, true);
    assert.equal(body.snapshot.milestonesValid, true);
    assert.deepEqual(body.snapshot.pendingBlocks, []);
    assert.equal(body.snapshot.authorizationsComplete, true);
    assert.equal(body.snapshot.releaseApplicable, true);
    // Mirror and DB agree — the F1 inconsistency is gone.
    assert.equal(body.state.stage, 'DONE');
    assert.equal(body.state.finalSeal, 1);
    assert.equal(body.state.dbStatus, 'DONE');
    assert.equal(body.state.milestones['DONE'].achieved, true);
    const row = rTasks.get(taskId);
    assert.equal(row.status, 'DONE');
    assert.ok(row.completedAt !== null, 'DONE write-back stamps completedAt');

    const view = await call('GET', `/api/tasks/${taskId}/v2-state`);
    const v = view.body as { stage: string; finalSeal: number; dbStatus: string };
    assert.equal(v.stage, 'DONE');
    assert.equal(v.finalSeal, 1);
    assert.equal(v.dbStatus, 'DONE');
  });

  it('POST /v2-complete from TODO is 422 (finalize only from OUTCOME_VERIFICATION) and the DB is unchanged', async () => {
    const taskId = rTasks.create({ projectId: 'p1', title: 'too early', creator: 'human' }).id;
    const r = await call('POST', `/api/tasks/${taskId}/v2-complete`, { by: 'human' });
    assert.equal(r.status, 422);
    const body = r.body as { ok: boolean; reasonCode: string; missing: string[] };
    assert.equal(body.ok, false);
    assert.equal(body.reasonCode, 'POLICY_DENIED');
    assert.ok(body.missing.some((m) => m.includes('OUTCOME_VERIFICATION')));
    assert.equal(rTasks.get(taskId).status, 'TODO');
  });

  it('POST /v2-transition to DONE is still 422 — finalize is the only road to DONE', async () => {
    const taskId = rTasks.create({ projectId: 'p1', title: 'no shortcut', creator: 'human' }).id;
    const r = await call('POST', `/api/tasks/${taskId}/v2-transition`, {
      toState: 'DONE', by: 'human', requirementVersion: 'REQ-RTE@1',
    });
    assert.equal(r.status, 422);
    const body = r.body as { ok: boolean; missing: string[] };
    assert.equal(body.ok, false);
    assert.ok(body.missing.some((m) => m.includes('finalize')));
    assert.equal(rTasks.get(taskId).status, 'TODO');
  });

  it('POST /v2-complete on an unknown task is 404', async () => {
    const r = await call('POST', '/api/tasks/nope/v2-complete', { by: 'human' });
    assert.equal(r.status, 404);
  });
});

// ----------------------------------------------------- service level --

describe('v2 completion snapshot predicates (§20.1, F1)', () => {
  it('an unverified AC denies completion with the DB and engine untouched; adding the declared evidence completes', () => {
    const mgr = makeManager([
      {
        id: 'AC-002',
        description: 'deployment independently verified',
        verificationType: 'AUTOMATED_TEST',
        verifiedBy: 'INDEPENDENT_QA',
        // The deployment GATE requires only the artifact (no verdict);
        // this AC additionally demands a verification record — absent
        // at first, so completion must deny until it exists.
        expectedEvidence: 'deployment with verdict VERIFIED',
        applicableEnvironments: ['PROD'],
      },
    ]);
    const { tasks, evidence, service, taskId } = makeService({ requirements: mgr });
    seedEvidence(evidence, taskId, 'REQ-001@1');
    walkToOutcomeVerification(service, taskId, 'REQ-001@1');

    const denied = service.complete(taskId, 'human', {});
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reasonCode, 'MISSING_EVIDENCE');
      assert.ok(
        denied.missing?.some((m) => m.includes('all-acs-verified')),
        `missing should name the AC predicate, got ${JSON.stringify(denied.missing)}`,
      );
      // The returned snapshot shows exactly which AC failed.
      assert.deepEqual(denied.snapshot?.applicableAcs, [
        { id: 'AC-001', verified: true },
        { id: 'AC-002', verified: false },
      ]);
    }
    // Nothing moved: engine still at OUTCOME_VERIFICATION, no seal, DB
    // row still carries the OUTCOME_VERIFICATION write-back status.
    const view = service.stateView(taskId);
    assert.equal(view.stage, 'OUTCOME_VERIFICATION');
    assert.equal(view.finalSeal, 0);
    assert.equal(tasks.get(taskId).status, 'PROD_VERIFICATION');

    evidence.create({
      taskId, type: 'deployment', title: 'deployment verification record',
      payload: { verdict: 'VERIFIED', environment: 'prod', digest: 'cand-1' },
      createdBy: 'human',
    });
    const done = service.complete(taskId, 'human', {});
    assert.equal(done.ok, true);
    if (done.ok) assert.equal(done.finalSeal, 1);
    assert.equal(tasks.get(taskId).status, 'DONE');
  });

  it('a PENDING approval record blocks completion until it is decided', () => {
    let rows: Array<{ status: string }> = [{ status: 'PENDING' }];
    const approvals = { listByTask: (_id: string) => rows };
    const { tasks, evidence, service, taskId } = makeService({
      requirements: makeManager(),
      approvals,
    });
    seedEvidence(evidence, taskId, 'REQ-001@1');
    walkToOutcomeVerification(service, taskId, 'REQ-001@1');

    const denied = service.complete(taskId, 'human', {});
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reasonCode, 'AUTHORIZATION_EXPIRED');
      assert.equal(denied.snapshot?.authorizationsComplete, false);
    }
    assert.equal(tasks.get(taskId).status, 'PROD_VERIFICATION');

    rows = [{ status: 'APPROVED' }];
    const done = service.complete(taskId, 'human', {});
    assert.equal(done.ok, true);
    assert.equal(tasks.get(taskId).status, 'DONE');
  });

  it('an unfinished hard dependency blocks completion (pendingBlocks names it)', () => {
    const { tasks, evidence, service, taskId } = makeService({
      requirements: makeManager(),
    });
    const depId = tasks.create({ projectId: 'p1', title: 'prerequisite', creator: 'human' }).id;
    tasks.addDependency(taskId, 'depends_on', depId);
    tasks.setStatus(depId, 'DONE'); // ready while the stage walk runs
    seedEvidence(evidence, taskId, 'REQ-001@1');
    walkToOutcomeVerification(service, taskId, 'REQ-001@1');

    tasks.setStatus(depId, 'IN_PROGRESS'); // the prerequisite regresses
    const denied = service.complete(taskId, 'human', {});
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reasonCode, 'DEPENDENCY_NOT_READY');
      assert.ok(
        denied.snapshot?.pendingBlocks.some((b) => b.includes(depId)),
        `pendingBlocks should name the dependency, got ${JSON.stringify(denied.snapshot?.pendingBlocks)}`,
      );
    }
    assert.equal(tasks.get(taskId).status, 'PROD_VERIFICATION');

    tasks.setStatus(depId, 'DONE');
    const done = service.complete(taskId, 'human', {});
    assert.equal(done.ok, true);
  });

  it('a rollback invalidates the outcome gate and completion is denied on gates-valid', () => {
    const { tasks, evidence, service, taskId } = makeService({
      requirements: makeManager(),
    });
    seedEvidence(evidence, taskId, 'REQ-001@1');
    walkToOutcomeVerification(service, taskId, 'REQ-001@1');

    service.engine.recordRollback(taskId, 'human', 'bad deploy — outcome gate invalidated');
    const denied = service.complete(taskId, 'human', {});
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reasonCode, 'STALE_EVIDENCE');
      assert.equal(denied.snapshot?.gatesValid, false);
    }
    assert.equal(tasks.get(taskId).status, 'PROD_VERIFICATION');
    assert.equal(service.stateView(taskId).finalSeal, 0);
  });

  it('an unresolvable pin completes with a surfaced warning (audit + response), never silently', () => {
    const { audit, evidence, service, taskId } = makeService(); // no manager wired
    seedEvidence(evidence, taskId, 'REQ-404@1');
    walkToOutcomeVerification(service, taskId, 'REQ-404@1');

    const done = service.complete(taskId, 'human', {});
    assert.equal(done.ok, true);
    if (done.ok) {
      assert.equal(done.warnings.length, 1);
      assert.ok(done.warnings[0].includes('REQ-404@1'));
      assert.deepEqual(done.snapshot.applicableAcs, []);
    }
    assert.ok(
      audit.list().some(
        (r) => r.action === 'COMPLETION_ACS_UNRESOLVED' && r.entityId === taskId,
      ),
      'the unresolved-AC fallback is audit-logged',
    );
  });
});

// ------------------------------------------------------------- sealing --

describe('evidence sealing on v2 transitions (§42, F3)', () => {
  it('gate-consumed evidence is sealed on success and becomes immutable', () => {
    const { evidence, service, taskId } = makeService({ requirements: makeManager() });
    const byType = seedEvidence(evidence, taskId, 'REQ-001@1');
    const plan = byType.get('plan')!;

    service.transition(taskId, 'PLANNING', 'human', { requirementVersion: 'REQ-001@1' });
    // TODO→PLANNING consumes no evidence: the plan is not sealed yet.
    assert.equal(evidence.statusOf(plan.id), 'DRAFT');

    const r = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@1', budgetOk: true,
    });
    assert.equal(r.ok, true);
    // PLANNING→IN_PROGRESS consumed the plan: sealed, immutable.
    assert.equal(evidence.statusOf(plan.id), 'SEALED');
    assert.throws(() => evidence.update(plan.id, { title: 'rewrite history' }), /SEALED/);
    assert.throws(() => evidence.delete(plan.id), /SEALED/);

    // Walk the rest: every consumed record ends up sealed.
    const rest: Array<[Parameters<V2TransitionService['transition']>[1], Record<string, unknown>]> = [
      ['CODE_REVIEW', { candidateDigest: 'cand-1', confinementOk: true, leaseValid: true, leaseId: 'lease-1', implementerId: 'agent-1' }],
      ['PENDING_QA', { implementerId: 'agent-1' }],
      ['QA', { quotaOk: true }],
      ['PENDING_UAT_MERGE', {}],
      ['UAT', { candidateDigest: 'cand-1' }],
      ['PENDING_PROD', {}],
      ['PROD_DEPLOYING', {}],
      ['PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-2' }],
      ['OUTCOME_VERIFICATION', {}],
    ];
    for (const [to, extra] of rest) {
      const step = service.transition(taskId, to, 'human', { requirementVersion: 'REQ-001@1', ...extra });
      assert.equal(step.ok, true, `→ ${to}: ${JSON.stringify(step)}`);
    }
    for (const type of ['code_change', 'code_review', 'ci_result', 'qa_result', 'security_report', 'merge', 'uat_result', 'deployment', 'smoke_test']) {
      assert.equal(
        evidence.statusOf(byType.get(type)!.id),
        'SEALED',
        `${type} was gate-consumed and must be sealed`,
      );
    }
  });

  it('a denied transition seals nothing; fixing the fact and retrying seals the consumed set', () => {
    const { evidence, service, taskId } = makeService({ requirements: makeManager() });
    const byType = seedEvidence(evidence, taskId, 'REQ-001@1');
    // Break one QA input: ci_result verdict FAIL (a DRAFT record can be updated).
    const ci = byType.get('ci_result')!;
    evidence.update(ci.id, { payload: { verdict: 'FAIL' } });

    const pin = 'REQ-001@1';
    const steps: Array<[Parameters<V2TransitionService['transition']>[1], Record<string, unknown>]> = [
      ['PLANNING', {}],
      ['IN_PROGRESS', { budgetOk: true }],
      ['CODE_REVIEW', { candidateDigest: 'cand-1', confinementOk: true, leaseValid: true, leaseId: 'lease-1', implementerId: 'agent-1' }],
      ['PENDING_QA', { implementerId: 'agent-1' }],
      ['QA', { quotaOk: true }],
    ];
    for (const [to, extra] of steps) {
      const step = service.transition(taskId, to, 'human', { requirementVersion: pin, ...extra });
      assert.equal(step.ok, true, `→ ${to}: ${JSON.stringify(step)}`);
    }

    const denied = service.transition(taskId, 'PENDING_UAT_MERGE', 'human', { requirementVersion: pin });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reasonCode, 'MISSING_EVIDENCE');
    // The denial consumed nothing: the QA edge's evidence set is untouched.
    for (const type of ['ci_result', 'qa_result', 'security_report']) {
      assert.equal(evidence.statusOf(byType.get(type)!.id), 'DRAFT', `${type} must stay DRAFT after a denial`);
    }

    evidence.update(ci.id, { payload: { verdict: 'PASS' } });
    const ok = service.transition(taskId, 'PENDING_UAT_MERGE', 'human', { requirementVersion: pin });
    assert.equal(ok.ok, true);
    for (const type of ['ci_result', 'qa_result', 'security_report']) {
      assert.equal(evidence.statusOf(byType.get(type)!.id), 'SEALED', `${type} sealed once the gate passes`);
    }
  });

  it('predicate-checked approval evidence is NOT sealed — sealing tracks consumption only', () => {
    const { evidence, service, taskId } = makeService({ requirements: makeManager() });
    const byType = seedEvidence(evidence, taskId, 'REQ-001@1');
    walkToOutcomeVerification(service, taskId, 'REQ-001@1');
    // The PENDING_PROD gate inspected the approval via a predicate; it
    // was never in any edge's requiredEvidence, so it stays DRAFT —
    // while the deployment evidence the next gate consumed is sealed.
    assert.equal(evidence.statusOf(byType.get('approval')!.id), 'DRAFT');
    assert.equal(evidence.statusOf(byType.get('deployment')!.id), 'SEALED');
    assert.equal(evidence.statusOf(byType.get('smoke_test')!.id), 'SEALED');
  });
});
