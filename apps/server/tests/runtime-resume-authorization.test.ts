/**
 * §28.4 × §17.2 (Batch 18) — the resume revalidation gains the
 * taskAuthorized item: a run may only resume while its task is
 * AUTHORIZED on the §17.2 axis. This pins the item at the
 * evaluateResumeChecks level (the route renders this object
 * verbatim), in the same world shape as runtime-resume.test.ts:
 *
 *  1. AUTHORIZED task → taskAuthorized ok, and every other check ok
 *     (the checkpoint is assembled after all task mutations, so the
 *     task-version item is not a confound).
 *  2. The same task REVOKED after its checkpoint → taskAuthorized is
 *     the ONLY failing item, naming the status.
 *  3. A WAITING_HUMAN_DISPATCH task → taskAuthorized fails with that
 *     status (resume is not a side door around Human Dispatch).
 *  4. A missing task → taskAuthorized fails closed (its
 *     authorization cannot be verified), alongside taskExists.
 *
 * Tasks recorded before the axis existed read AUTHORIZED (Batch 17's
 * compatibility rule), which is why every pre-existing resume test —
 * whose tasks never touch the axis — is unaffected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
} from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';
import {
  assembleRunCheckpoint,
  evaluateResumeChecks,
  type RuntimeRunRecord,
} from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';

function makeWorld(file: string) {
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
  fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
  const agent = agents.register({ name: 'coder', jobTitle: 'Engineer' });
  const task = tasks.create({
    projectId: 'p1',
    title: 'T',
    goal: 'g',
    description: '',
    priority: 'P2',
    acceptanceCriteria: [],
    constraints: [],
    creator: 'human',
  });
  return { fdb, tasks, evidence, audit, agents, agent, task };
}

function makeCtx(world: ReturnType<typeof makeWorld>): RouteContext {
  return {
    tasks: world.tasks,
    evidence: world.evidence,
    audit: world.audit,
    agents: world.agents,
    engine: new WorkflowEngine({
      tasks: world.tasks,
      evidence: world.evidence,
      audit: world.audit,
    }),
    fdb: world.fdb,
    stepIntentStore: world.fdb.stepIntents,
    notify: { emit: () => {} },
    bus: { emit: () => {} },
    archivedTaskBody: (taskId: string) => {
      const projectId = world.fdb.tasks.get(taskId)?.projectId;
      const project = projectId ? world.fdb.getProject(projectId) : undefined;
      return project && project.status === 'archived'
        ? {
            error: `project is archived: ${projectId} (unarchive it to write again)`,
            code: 'PROJECT_ARCHIVED' as const,
            projectId: projectId as string,
          }
        : null;
    },
    json: () => {},
    readBody: async () => ({}),
  } as unknown as RouteContext;
}

function recFor(world: ReturnType<typeof makeWorld>, taskId: string): RuntimeRunRecord {
  return {
    id: randomUUID(),
    agentId: world.agent.id,
    taskId,
    status: 'RUNNING',
    outcome: null,
    steps: 0,
    evidence: [],
    handoffs: [],
    trace: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
}

function checkpointFor(
  world: ReturnType<typeof makeWorld>,
  runId: string,
  taskId: string,
) {
  return assembleRunCheckpoint({
    runId,
    stepPosition: 2,
    agent: world.agent,
    task: world.tasks.get(taskId),
    grantedTools: [],
    budgetUsage: {},
    activeTools: [],
    pendingApprovals: [],
  });
}

describe('§28.4 resume revalidation — the taskAuthorized item (Batch 18)', () => {
  it('AUTHORIZED task: taskAuthorized passes and so does everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-resume-authz-'));
    const world = makeWorld(join(dir, 'f.db'));
    try {
      const rec = recFor(world, world.task.id);
      const checks = evaluateResumeChecks(
        makeCtx(world),
        rec,
        checkpointFor(world, rec.id, world.task.id),
      );
      assert.equal(checks.taskAuthorized.ok, true);
      assert.equal(checks.taskAuthorized.authorizationStatus, 'AUTHORIZED');
      for (const [name, check] of Object.entries(checks)) {
        assert.equal(check.ok, true, `check ${name} should pass: ${check.detail}`);
      }
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REVOKED task: taskAuthorized is the ONLY failing item', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-resume-authz-'));
    const world = makeWorld(join(dir, 'f.db'));
    try {
      const rec = recFor(world, world.task.id);
      // Revoke FIRST, then assemble the checkpoint from the current
      // task — any task mutation bumps the version marker, so this
      // ordering isolates the authorization item from
      // taskVersionCurrent.
      world.tasks.revokeAuthorization(world.task.id);
      const checks = evaluateResumeChecks(
        makeCtx(world),
        rec,
        checkpointFor(world, rec.id, world.task.id),
      );
      assert.equal(checks.taskAuthorized.ok, false);
      assert.equal(checks.taskAuthorized.authorizationStatus, 'REVOKED');
      assert.match(checks.taskAuthorized.detail, /REVOKED/);
      for (const [name, check] of Object.entries(checks)) {
        if (name === 'taskAuthorized') continue;
        assert.equal(check.ok, true, `check ${name} should pass: ${check.detail}`);
      }
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WAITING_HUMAN_DISPATCH task: resume does not bypass Human Dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-resume-authz-'));
    const world = makeWorld(join(dir, 'f.db'));
    try {
      const waiting = world.tasks.create({
        projectId: 'p1',
        title: 'W',
        goal: 'g',
        description: '',
        priority: 'P2',
        acceptanceCriteria: [],
        constraints: [],
        creator: 'human',
        authorizationStatus: 'DRAFT',
      });
      world.tasks.requestDispatch(waiting.id);
      const rec = recFor(world, waiting.id);
      const checks = evaluateResumeChecks(
        makeCtx(world),
        rec,
        checkpointFor(world, rec.id, waiting.id),
      );
      assert.equal(checks.taskAuthorized.ok, false);
      assert.equal(
        checks.taskAuthorized.authorizationStatus,
        'WAITING_HUMAN_DISPATCH',
      );
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing task: taskAuthorized fails closed alongside taskExists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-resume-authz-'));
    const world = makeWorld(join(dir, 'f.db'));
    try {
      const rec = recFor(world, 'no-such-task');
      const checks = evaluateResumeChecks(makeCtx(world), rec, undefined);
      assert.equal(checks.taskExists.ok, false);
      assert.equal(checks.taskAuthorized.ok, false);
      assert.match(checks.taskAuthorized.detail, /cannot be verified/);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
