/**
 * v2 transition route tests — SPEC_V2 §18.2 (gap G-18 wiring).
 *
 * The v2 engine is wired into the server: POST /api/tasks/:id/v2-transition
 * runs WorkflowEngineV2 gates, writes the result back to the DB task row on
 * success, and leaves the DB untouched on a gate denial.
 * GET /api/tasks/:id/v2-state exposes the three-state view.
 *
 * NOTE: this file imports the route from dist (../dist/routes/v2-transitions.js).
 * Since Batch 7-2, v2-transitions.ts value-imports the shared
 * RequirementManager accessor from the sibling route module
 * ('./requirements', extensionless) — the same pattern dashboard.ts uses
 * with './qa'/'./cicd'/'./resources'. CommonJS/tsc resolve that fine but
 * Node's type-stripping ESM loader cannot, so (like dashboard-aocr.test.ts)
 * this test runs against the compiled dist and requires
 * `npm run build -w @ai-factory/server` first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import { RequirementManager } from '@ai-factory/requirements';
import {
  createV2TransitionService,
  handleV2TransitionRoutes,
} from '../dist/routes/v2-transitions.js';
import type { V2TransitionService } from '../dist/routes/v2-transitions.js';

const tasks = new TaskManager();
const evidence = new EvidenceEngine();
const audit = new AuditLog();

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      tasks,
      evidence,
      audit,
      bus: { emit: () => {} },
      readBody: async () => body,
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
    } as never,
    calls,
  };
}

async function call(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
) {
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

function newTask(title: string): string {
  return tasks.create({ projectId: 'p1', title, creator: 'human' }).id;
}

describe('v2 transition wiring (§18.2, G-18)', () => {
  it('legal transition succeeds and writes the stage back to the DB', async () => {
    const id = newTask('v2 legal');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; from: string; to: string; state: { stage: string } };
    assert.equal(body.ok, true);
    assert.equal(body.from, 'TODO');
    assert.equal(body.to, 'PLANNING');
    assert.equal(body.state.stage, 'PLANNING');
    // Write-back: the DB row moved too.
    assert.equal(tasks.get(id).status, 'PLANNING');
  });

  it('illegal jump is denied 422 and the DB is unchanged', async () => {
    const id = newTask('v2 illegal');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'QA',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(r.status, 422);
    const body = r.body as { ok: boolean; reasonCode: string };
    assert.equal(body.ok, false);
    assert.equal(body.reasonCode, 'POLICY_DENIED');
    assert.equal(tasks.get(id).status, 'TODO');
  });

  it('unpinned requirement is denied fail-closed (no fake pass)', async () => {
    const id = newTask('v2 unpinned');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      // no requirementVersion — the requirement-pinned gate must deny
    });
    assert.equal(r.status, 422);
    assert.equal(tasks.get(id).status, 'TODO');
  });

  it('missing required evidence is denied and the DB is unchanged', async () => {
    const id = newTask('v2 evidence gate');
    const seed = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(seed.status, 200);
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'IN_PROGRESS',
      by: 'human',
      requirementVersion: 'REQ-001@1',
      budgetOk: true,
      // no 'plan' evidence attached — PLANNING→IN_PROGRESS requires it
    });
    assert.equal(r.status, 422);
    assert.equal((r.body as { reasonCode: string }).reasonCode, 'MISSING_EVIDENCE');
    assert.equal(tasks.get(id).status, 'PLANNING');
  });

  it('GET v2-state returns the three-state view seeded from the DB', async () => {
    const id = newTask('v2 state view');
    const r = await call('GET', `/api/tasks/${id}/v2-state`);
    assert.equal(r.status, 200);
    const body = r.body as {
      stage: string;
      condition: { condition: string };
      milestones: Record<string, { achieved: boolean }>;
      dbStatus: string;
    };
    assert.equal(body.stage, 'TODO');
    assert.equal(body.condition.condition, 'ACTIVE');
    assert.equal(body.dbStatus, 'TODO');
    assert.equal(body.milestones['DONE'].achieved, false);
  });

  it('unknown task → 404 on both endpoints', async () => {
    const g = await call('GET', '/api/tasks/nope/v2-state');
    assert.equal(g.status, 404);
    const p = await call('POST', '/api/tasks/nope/v2-transition', {
      toState: 'PLANNING',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(p.status, 404);
  });

  it('missing or unknown target stage → 400', async () => {
    const id = newTask('v2 bad target');
    const missing = await call('POST', `/api/tasks/${id}/v2-transition`, {});
    assert.equal(missing.status, 400);
    const bogus = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'BLOCKED', // a v1 exception status, not a v2 stage
    });
    assert.equal(bogus.status, 400);
  });
});

describe('v2 transition §16 compatibility wiring', () => {
  // Service-level seam (createV2TransitionService): the gate assembly must
  // consult the requirements manager's explicit declarations for the
  // task's pinned version and pass matching evidence ids to the engine as
  // GateContext.compatibleEvidenceIds. (Since Batch 8 the assembly also
  // passes the recorded per-evidence requirement versions — see the
  // Batch 8 describe block below for the full stale/compatible chain.
  // The evidence here carries no recorded version, so these cases pin the
  // declaration-consultation behavior itself.)
  function setup(requirements?: Pick<RequirementManager, 'canReuseEvidence' | 'getVersion'>) {
    const tasks = new TaskManager();
    const evidence = new EvidenceEngine();
    const audit = new AuditLog();
    const service = createV2TransitionService({ tasks, evidence, audit, requirements });
    const taskId = tasks.create({ projectId: 'p1', title: 'compat wiring', creator: 'human' }).id;
    const plan = evidence.create({
      taskId, type: 'plan', title: 'PLAN', payload: {}, createdBy: 'tester',
    });
    return { service, taskId, planId: plan.id };
  }

  function advanceToInProgress(service: V2TransitionService, taskId: string) {
    const seed = service.transition(taskId, 'PLANNING', 'human', {
      requirementVersion: 'REQ-001@2',
    });
    assert.equal(seed.ok, true);
    return service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
  }

  it('gate assembly consults canReuseEvidence with the parsed pin for task evidence', () => {
    const calls: Array<[string, string, number]> = [];
    let planId = '';
    const stub = {
      canReuseEvidence: (id: string, req: string, v: number): boolean => {
        calls.push([id, req, v]);
        return id === planId;
      },
      // Gate assembly never reads versions; getVersion only serves the
      // §20.1 completion snapshot, which these cases do not exercise.
      getVersion: (): never => {
        throw new Error('getVersion is not exercised by gate assembly');
      },
    };
    const s = setup(stub);
    planId = s.planId;
    const r = advanceToInProgress(s.service, s.taskId);
    assert.equal(r.ok, true);
    assert.ok(
      calls.some(([id, req, v]) => id === planId && req === 'REQ-001' && v === 2),
      `expected a canReuseEvidence(${planId}, 'REQ-001', 2) consultation, got ${JSON.stringify(calls)}`,
    );
  });

  it('real RequirementManager: an explicit compatible declaration for the pinned version flows through', () => {
    const mgr = new RequirementManager();
    const s = setup(mgr);
    mgr.checkEvidenceCompatibility(s.planId, 'REQ-001', 2, true, 'ACs unchanged by v2', 'human');
    assert.equal(mgr.canReuseEvidence(s.planId, 'REQ-001', 2), true);
    const r = advanceToInProgress(s.service, s.taskId);
    assert.equal(r.ok, true);
  });

  it('no requirements dep → behavior unchanged (legal path still works)', () => {
    const s = setup(undefined);
    const r = advanceToInProgress(s.service, s.taskId);
    assert.equal(r.ok, true);
  });
});

describe('v2 evidence requirement versions (§16/§18.2, Batch 8)', () => {
  // End-to-end at the service seam: evidence is registered with the
  // requirement version it was collected against (REQ-001@1, the same
  // value POST /api/tasks/:id/evidence now persists). The requirement is
  // then bumped to v2 and the task pins v2 — gateContext feeds the
  // recorded version to the engine, the version-mismatch branch denies
  // with STALE_EVIDENCE, and only an explicit §16 compatibility
  // declaration for v2 lets the same evidence through.
  function setup() {
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
      ],
      createdBy: 'human',
    });
    // The requirement moves to v2 (a CORRECTION that touches neither the
    // completion target nor AC meaning needs no HUMAN authorization).
    mgr.newVersion('REQ-001', 'CORRECTION', 'fix rationale typo', 'human', (draft) => {
      draft.rationale = 'corrected rationale';
    });
    const tasks = new TaskManager();
    const evidence = new EvidenceEngine();
    const audit = new AuditLog();
    const service = createV2TransitionService({ tasks, evidence, audit, requirements: mgr });
    const taskId = tasks.create({ projectId: 'p1', title: 'versioned evidence', creator: 'human' }).id;
    return { mgr, tasks, evidence, service, taskId };
  }

  it('evidence recorded against REQ@1 is STALE under a REQ@2 pin (422 semantics, DB untouched), then a compatibility declaration lets it through', () => {
    const { mgr, tasks, evidence, service, taskId } = setup();
    // Evidence collected while the task pinned REQ-001@1.
    const plan = evidence.create({
      taskId, type: 'plan', title: 'PLAN', payload: {}, createdBy: 'tester',
      requirementVersion: 'REQ-001@1',
    });
    const seed = service.transition(taskId, 'PLANNING', 'human', {
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(seed.ok, true);

    // Requirement is now at v2 and the task pins v2: the recorded @1
    // version mismatches → STALE_EVIDENCE denial, DB row untouched.
    const denied = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reasonCode, 'STALE_EVIDENCE');
      assert.ok(
        denied.missing.some((m) => m.includes('REQ-001@1') && m.includes('REQ-001@2')),
        `missing should name both versions, got ${JSON.stringify(denied.missing)}`,
      );
    }
    assert.equal(tasks.get(taskId).status, 'PLANNING');

    // Explicit §16 declaration: the same evidence is compatible with v2.
    mgr.checkEvidenceCompatibility(plan.id, 'REQ-001', 2, true, 'ACs unchanged by v2', 'human');
    const allowed = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
    assert.equal(allowed.ok, true);
    assert.equal(tasks.get(taskId).status, 'IN_PROGRESS');
  });

  it('evidence recorded against the pinned version itself passes without any declaration', () => {
    const { tasks, evidence, service, taskId } = setup();
    evidence.create({
      taskId, type: 'plan', title: 'PLAN', payload: {}, createdBy: 'tester',
      requirementVersion: 'REQ-001@2',
    });
    assert.equal(
      service.transition(taskId, 'PLANNING', 'human', { requirementVersion: 'REQ-001@2' }).ok,
      true,
    );
    const r = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
    assert.equal(r.ok, true);
    assert.equal(tasks.get(taskId).status, 'IN_PROGRESS');
  });

  it('evidence with NO recorded version is never judged stale (no invented version)', () => {
    const { tasks, evidence, service, taskId } = setup();
    // Registered without a requirement context — as every pre-Batch-8 row
    // and every context-less registration still is.
    evidence.create({
      taskId, type: 'plan', title: 'PLAN', payload: {}, createdBy: 'tester',
    });
    assert.equal(
      service.transition(taskId, 'PLANNING', 'human', { requirementVersion: 'REQ-001@1' }).ok,
      true,
    );
    const r = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
    assert.equal(r.ok, true);
    assert.equal(tasks.get(taskId).status, 'IN_PROGRESS');
  });

  it('a compatible=false declaration does NOT exempt stale evidence', () => {
    const { mgr, tasks, evidence, service, taskId } = setup();
    const plan = evidence.create({
      taskId, type: 'plan', title: 'PLAN', payload: {}, createdBy: 'tester',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(
      service.transition(taskId, 'PLANNING', 'human', { requirementVersion: 'REQ-001@1' }).ok,
      true,
    );
    mgr.checkEvidenceCompatibility(plan.id, 'REQ-001', 2, false, 'ACs changed in v2', 'human');
    const r = service.transition(taskId, 'IN_PROGRESS', 'human', {
      requirementVersion: 'REQ-001@2',
      budgetOk: true,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reasonCode, 'STALE_EVIDENCE');
    assert.equal(tasks.get(taskId).status, 'PLANNING');
  });
});
