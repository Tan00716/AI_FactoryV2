/**
 * Durable v2 engine state — SPEC v2 §18/§19/§20.1 (Batch 13).
 *
 * Until now the V2TransitionService's WorkflowEngineV2 mirror lived
 * only in the server process: a restart re-seeded it approximately
 * from the v1 task row, losing recorded milestones, histories, the
 * taskVersion and the §20.1 final seal (a DONE task came back with
 * finalSeal 0 — the Batch 12 F1 residual). With FactoryDatabase's
 * taskV2States store wired into the service, the mirror is persisted
 * after every committed mutation and hydrated verbatim on first
 * access. This file pins, across REAL restarts (the database file is
 * closed and reopened under a fresh FactoryDatabase + fresh managers
 * + a fresh service — a new process in every respect that matters):
 *
 *  1. Full lifecycle: walk TODO → OUTCOME_VERIFICATION, finalize,
 *     restart — GET v2-state (service view AND the full engine state)
 *     is field-for-field identical to before the restart, finalSeal 1
 *     included; a second restart changes nothing (hydration is not a
 *     mutation — taskVersion does not drift).
 *  2. Mid-lifecycle: restart at QA, then CONTINUE the walk in the new
 *     process and finalize — the hydrated state is functional, not
 *     just readable (gates judge the persisted pin/taskVersion).
 *  3. Legacy tasks (no task_v2_state row): first access still takes
 *     the approximate v1-row seed (BLOCKED → condition, stage mapped
 *     from the row) and persists it immediately; afterwards hydration
 *     wins — including the exact OUTCOME_VERIFICATION stage, which
 *     the v1 row can only express as PROD_VERIFICATION (the lossy
 *     write-back stays for v1 consumers; the exact stage lives in
 *     the persisted mirror and in GET /v2-state).
 *  4. Route level: GET /api/tasks/:id/v2-state after a restart is
 *     served from the hydrated mirror via the ctx wiring
 *     (getV2TransitionService picks ctx.fdb.taskV2States up behind
 *     its shape guard).
 *
 * Like v2-transitions.test.ts this runs against the compiled dist and
 * requires `npm run build -w @ai-factory/server` first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import type { Evidence } from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';
import { RequirementManager } from '@ai-factory/requirements';
import {
  createV2TransitionService,
  handleV2TransitionRoutes,
} from '../dist/routes/v2-transitions.js';
import type { V2TransitionService } from '../dist/routes/v2-transitions.js';

// ------------------------------------------------------------ fixtures --

const PIN = 'REQ-001@1';

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

function seedEvidence(evidence: EvidenceEngine, taskId: string, pin?: string): void {
  for (const [type, payload] of EVIDENCE_PLAN) {
    evidence.create({
      taskId,
      type: type as Evidence['type'],
      title: `${type} (persistence test)`,
      payload,
      createdBy: 'human',
      requirementVersion: type === 'plan' && pin ? pin : null,
    });
  }
}

function makeManager(): RequirementManager {
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
  } as never);
  return mgr;
}

/**
 * One "process": a FactoryDatabase over the file, the core managers
 * backed by its stores, and a v2 service wired to its taskV2States —
 * exactly what apps/server/src/index.ts + getV2TransitionService build.
 */
function makeWorld(file: string) {
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const service = createV2TransitionService({
    tasks,
    evidence,
    audit,
    requirements: makeManager(),
    v2States: fdb.taskV2States,
  });
  return { fdb, tasks, evidence, audit, service };
}

function newTask(world: ReturnType<typeof makeWorld>, title: string): string {
  if (!world.fdb.getProject('p1')) {
    world.fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
  }
  return world.tasks.create({
    projectId: 'p1',
    title,
    goal: 'g',
    description: '',
    priority: 'P2',
    acceptanceCriteria: [],
    constraints: [],
    creator: 'human',
  }).id;
}

type Stage = Parameters<V2TransitionService['transition']>[1];

const WALK: Array<[Stage, Record<string, unknown>]> = [
  ['PLANNING', {}],
  ['IN_PROGRESS', { budgetOk: true }],
  ['CODE_REVIEW', {
    candidateDigest: 'cand-1',
    confinementOk: true,
    leaseValid: true,
    leaseId: 'lease-1',
    implementerId: 'agent-1',
  }],
  ['PENDING_QA', { implementerId: 'agent-1' }],
  ['QA', { quotaOk: true }],
  ['PENDING_UAT_MERGE', {}],
  ['UAT', { candidateDigest: 'cand-1' }],
  ['PENDING_PROD', {}],
  ['PROD_DEPLOYING', {}],
  ['PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-2' }],
  ['OUTCOME_VERIFICATION', {}],
];

function walk(
  service: V2TransitionService,
  taskId: string,
  steps: Array<[Stage, Record<string, unknown>]>,
): void {
  for (const [to, extra] of steps) {
    const r = service.transition(taskId, to, 'human', {
      requirementVersion: PIN,
      ...extra,
    });
    assert.equal(r.ok, true, `walk → ${to}: ${JSON.stringify(r)}`);
  }
}

function tmpDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-server-v2state-'));
  return { dir, file: join(dir, 'factory.db') };
}

// ------------------------------------------------------------- tests --

describe('v2 state persistence (§18/§19/§20.1, Batch 13)', () => {
  it('full lifecycle + finalize survives a restart field-for-field (finalSeal 1)', () => {
    const { dir, file } = tmpDir();
    try {
      // Boot A: walk the whole lifecycle and finalize.
      const a = makeWorld(file);
      const taskId = newTask(a, 'restart fidelity');
      seedEvidence(a.evidence, taskId, PIN);
      walk(a.service, taskId, WALK);
      const done = a.service.complete(taskId, 'human', {});
      assert.equal(done.ok, true, JSON.stringify(done));
      const viewA = a.service.stateView(taskId);
      const fullA = a.service.engine.get(taskId);
      assert.equal(viewA.stage, 'DONE');
      assert.equal(viewA.finalSeal, 1);
      // The store holds exactly the engine's committed state.
      assert.deepEqual(a.fdb.taskV2States.get(taskId), fullA);
      a.fdb.close();

      // Boot B: a fresh service over the reopened file hydrates the
      // exact state — no approximate re-seed, no lost seal.
      const b = makeWorld(file);
      const viewB = b.service.stateView(taskId);
      assert.deepEqual(viewB, viewA);
      assert.equal(viewB.finalSeal, 1);
      assert.equal(viewB.dbStatus, 'DONE');
      assert.deepEqual(b.service.engine.get(taskId), fullA);
      b.fdb.close();

      // Boot C: hydration is not a mutation — a second restart sees
      // byte-identical state (taskVersion/updatedAt do not drift).
      const c = makeWorld(file);
      assert.deepEqual(c.service.stateView(taskId), viewA);
      assert.deepEqual(c.service.engine.get(taskId), fullA);
      c.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mid-lifecycle restart: the walk continues from the hydrated state', () => {
    const { dir, file } = tmpDir();
    try {
      // Boot A: walk only as far as QA, then "crash".
      const a = makeWorld(file);
      const taskId = newTask(a, 'mid-lifecycle restart');
      seedEvidence(a.evidence, taskId, PIN);
      walk(a.service, taskId, WALK.slice(0, 5)); // …→ QA
      const viewA = a.service.stateView(taskId);
      assert.equal(viewA.stage, 'QA');
      assert.equal(viewA.milestones.IMPLEMENTED.achieved, true);
      a.fdb.close();

      // Boot B: state identical, and the remaining gates still pass
      // against the hydrated mirror (pin + taskVersion came from the
      // store, evidence from the reopened evidence table).
      const b = makeWorld(file);
      assert.deepEqual(b.service.stateView(taskId), viewA);
      walk(b.service, taskId, WALK.slice(5));
      const done = b.service.complete(taskId, 'human', {});
      assert.equal(done.ok, true, JSON.stringify(done));
      const viewB = b.service.stateView(taskId);
      assert.equal(viewB.stage, 'DONE');
      assert.equal(viewB.finalSeal, 1);
      b.fdb.close();

      // Boot C: the completion boot B committed is itself durable.
      const c = makeWorld(file);
      assert.deepEqual(c.service.stateView(taskId), viewB);
      c.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy task (no stored row): approximate seed on first access, persisted immediately', () => {
    const { dir, file } = tmpDir();
    try {
      const a = makeWorld(file);

      // A v1-era BLOCKED task: no v2 row exists yet.
      const blockedId = newTask(a, 'legacy blocked');
      a.tasks.setStatus(blockedId, 'BLOCKED');
      assert.equal(a.fdb.taskV2States.get(blockedId), undefined);
      const blockedView = a.service.stateView(blockedId);
      assert.equal(blockedView.stage, 'TODO'); // BLOCKED has no v2 stage
      assert.equal(blockedView.condition.condition, 'BLOCKED');
      // The seed was persisted on that first access.
      const seededRow = a.fdb.taskV2States.get(blockedId);
      assert.ok(seededRow);
      assert.equal(seededRow.condition.condition, 'BLOCKED');

      // A legacy task parked at PROD_VERIFICATION: seed, then one real
      // transition into OUTCOME_VERIFICATION — the stage the v1 row
      // cannot express (it keeps reading PROD_VERIFICATION).
      const parkedId = newTask(a, 'legacy parked');
      a.tasks.setStatus(parkedId, 'PROD_VERIFICATION');
      seedEvidence(a.evidence, parkedId);
      const r = a.service.transition(parkedId, 'OUTCOME_VERIFICATION', 'human', {
        requirementVersion: PIN,
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(a.tasks.get(parkedId).status, 'PROD_VERIFICATION'); // lossy write-back, unchanged
      a.fdb.close();

      // Boot B: hydration restores the EXACT stage and the milestones
      // the transition recorded — a re-seed from the v1 row would have
      // produced stage PROD_VERIFICATION with no milestones at all.
      const b = makeWorld(file);
      const view = b.service.stateView(parkedId);
      assert.equal(view.stage, 'OUTCOME_VERIFICATION');
      assert.equal(view.dbStatus, 'PROD_VERIFICATION');
      assert.equal(view.milestones.IMPLEMENTED.achieved, true);
      assert.equal(view.milestones.VERIFIED.achieved, true);
      assert.equal(view.milestones.RELEASED.achieved, true);
      assert.equal(view.milestones.OUTCOME_VERIFIED.achieved, true);
      assert.equal(view.finalSeal, 0);
      // The BLOCKED legacy task also hydrates (condition intact).
      const blockedB = b.service.stateView(blockedId);
      assert.deepEqual(blockedB, blockedView);
      b.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('route level: GET /v2-state after a restart is served from the hydrated mirror', async () => {
    const { dir, file } = tmpDir();
    try {
      // Boot A: walk + finalize at service level.
      const a = makeWorld(file);
      const taskId = newTask(a, 'route-level restart');
      seedEvidence(a.evidence, taskId, PIN);
      walk(a.service, taskId, WALK);
      const done = a.service.complete(taskId, 'human', {});
      assert.equal(done.ok, true, JSON.stringify(done));
      const viewA = a.service.stateView(taskId);
      a.fdb.close();

      // Boot B: the real route handler, with a RouteContext carrying
      // the reopened FactoryDatabase — the singleton service must pick
      // ctx.fdb.taskV2States up and hydrate from it.
      const b = makeWorld(file);
      const calls: Array<{ status: number; body: unknown }> = [];
      const ctx = {
        tasks: b.tasks,
        evidence: b.evidence,
        audit: b.audit,
        fdb: b.fdb,
        bus: { emit: () => {} },
        readBody: async () => ({}),
        json: (_res: unknown, status: number, body: unknown) => {
          calls.push({ status, body });
        },
      } as never;
      const handled = await handleV2TransitionRoutes(
        { method: 'GET' } as never,
        {} as never,
        new URL(`http://localhost/api/tasks/${taskId}/v2-state`),
        ctx,
      );
      assert.equal(handled, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].status, 200);
      const body = calls[0].body as {
        stage: string;
        finalSeal: number;
        taskVersion: number;
        dbStatus: string;
      };
      assert.equal(body.stage, 'DONE');
      assert.equal(body.finalSeal, 1);
      assert.equal(body.taskVersion, viewA.taskVersion);
      assert.equal(body.dbStatus, 'DONE');
      b.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
