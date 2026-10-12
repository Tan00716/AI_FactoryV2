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
  // GateContext.compatibleEvidenceIds. (The route assembles
  // evidenceReqVersions: {} — the server does not track per-evidence
  // requirement versions yet — so the exemption is verified here at the
  // assembly seam, not via an HTTP outcome difference.)
  function setup(requirements?: Pick<RequirementManager, 'canReuseEvidence'>) {
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
