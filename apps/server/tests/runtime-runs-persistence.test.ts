/**
 * Runtime run records survive restarts — walkthrough F4 (Batch 12).
 *
 * What this pins:
 *  1. With the coordinator's store installed (fdb.runs, SQLite — the
 *     object apps/server/src/index.ts installs via setRuntimeRunStore),
 *     a run driven through the real route is still retrievable after
 *     the database is closed and reopened under a NEW FactoryDatabase:
 *     GET /api/runtime/runs/:id returns 200 with the record
 *     field-for-field identical to the pre-restart response (status,
 *     steps, evidence, trace, timestamps), and the list endpoint and
 *     the module accessor the Activity aggregation uses see it too.
 *     Before F4 the registry was a process-local Map and this GET was
 *     a 404.
 *  2. A record left RUNNING by a dead process is served back as-is
 *     after a restart — still RUNNING, not rewritten to a terminal
 *     state and not dropped: the honest record of an interrupted run.
 *
 * Imports the route from src (like runtime-intents.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
} from '@ai-factory/core';
import { FactoryDatabase, InMemoryRuntimeRunStore } from '@ai-factory/db';
import {
  RUNTIME_TOOLS_ENV,
  getRuntimeRun,
  handleRuntimeRoutes,
  setRuntimeRunStore,
  type RuntimeRunRecord,
} from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';

function makeWorld(file: string, seed = true) {
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
  // Reopening an existing file must not re-seed (primary keys); the
  // GET routes exercised there never touch agents/tasks anyway.
  let agent: ReturnType<AgentRegistry['register']> | undefined;
  let task: ReturnType<TaskManager['create']> | undefined;
  if (seed) {
    fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
    agent = agents.register({ name: 'coder', jobTitle: 'Engineer' });
    task = tasks.create({
      projectId: 'p1',
      title: 'T',
      goal: 'g',
      description: '',
      priority: 'P2',
      acceptanceCriteria: [],
      constraints: [],
      creator: 'human',
    });
  }
  return { fdb, tasks, evidence, audit, agents, agent: agent!, task: task! };
}

function makeCtx(world: ReturnType<typeof makeWorld>, body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  const ctx = {
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
    // Exactly the object apps/server/src/index.ts puts in RouteContext.
    stepIntentStore: world.fdb.stepIntents,
    notify: { emit: () => {} },
    bus: { emit: () => {} },
    json: (_res: unknown, status: number, body: unknown) => {
      calls.push({ status, body });
    },
    readBody: async () => body,
  } as unknown as RouteContext;
  return { ctx, calls };
}

async function call(
  world: ReturnType<typeof makeWorld>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  const { ctx, calls } = makeCtx(world, body);
  const handled = await handleRuntimeRoutes(
    { method } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

async function waitForRun(world: ReturnType<typeof makeWorld>, id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(world, 'GET', `/api/runtime/runs/${id}`);
    assert.equal(r.status, 200);
    const rec = r.body as RuntimeRunRecord;
    if (rec.status !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${id} did not finish in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe('runtime run records across restarts (F4)', () => {
  it('a completed run is retrievable field-for-field after a DB reopen', { timeout: 20_000 }, async () => {
    const prevEnv = process.env[RUNTIME_TOOLS_ENV];
    delete process.env[RUNTIME_TOOLS_ENV];
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-runs-'));
    const file = join(dir, 'a.db');
    try {
      let runId = '';
      let before: RuntimeRunRecord | undefined;
      const world = makeWorld(file);
      // The coordinator's wiring, exactly as index.ts performs it.
      setRuntimeRunStore(world.fdb.runs);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
        });
        assert.equal(post.status, 202);
        runId = (post.body as { id: string }).id;

        before = await waitForRun(world, runId);
        assert.equal(before.status, 'COMPLETED');
        assert.ok(before.finishedAt !== null);
        assert.ok(before.steps > 0);

        const listBefore = await call(world, 'GET', '/api/runtime/runs');
        assert.deepEqual(
          (listBefore.body as { runs: RuntimeRunRecord[] }).runs.map((r) => r.id),
          [runId],
        );
      } finally {
        world.fdb.close();
      }

      // A new process generation over the same file: the record is
      // still there, identical through every read surface.
      const world2 = makeWorld(file, false);
      try {
        setRuntimeRunStore(world2.fdb.runs);
        const got = await call(world2, 'GET', `/api/runtime/runs/${runId}`);
        assert.equal(got.status, 200);
        assert.deepEqual(got.body, before);

        const listAfter = await call(world2, 'GET', '/api/runtime/runs');
        // Batch 16 extended the list rows additively: each row is the
        // record plus the Observatory join (live / checkpointCount /
        // projectId / projectName / manifest summary — values pinned
        // by runtime-runs-list.test.ts). F4's claim is about the
        // RECORD's durability, so the comparison projects the row
        // back to the record fields; the single-run GET above keeps
        // the bare record shape and is compared whole.
        const listRows = (
          listAfter.body as { runs: Array<Record<string, unknown>> }
        ).runs;
        assert.equal(listRows.length, 1);
        const {
          live: _live,
          checkpointCount: _checkpointCount,
          projectId: _projectId,
          projectName: _projectName,
          manifest: _manifest,
          ...recordFields
        } = listRows[0];
        assert.deepEqual([recordFields], [before]);

        // The accessor the Activity aggregation (§67–§68) reads.
        assert.deepEqual(getRuntimeRun(runId), before);
      } finally {
        world2.fdb.close();
      }
    } finally {
      setRuntimeRunStore(new InMemoryRuntimeRunStore());
      if (prevEnv === undefined) delete process.env[RUNTIME_TOOLS_ENV];
      else process.env[RUNTIME_TOOLS_ENV] = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a record left RUNNING by a dead process is served back as-is', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-runs-'));
    const file = join(dir, 'b.db');
    try {
      // Generation 1 persists a mid-flight record and dies (no
      // terminal write ever lands).
      const world = makeWorld(file);
      const interrupted: RuntimeRunRecord = {
        id: 'interrupted-run',
        agentId: world.agent.id,
        taskId: world.task.id,
        status: 'RUNNING',
        outcome: null,
        steps: 1,
        evidence: [{ type: 'note', title: 'started', payload: {} }],
        handoffs: [],
        trace: [],
        createdAt: '2026-10-12T10:00:00.000Z',
        finishedAt: null,
        error: null,
      };
      world.fdb.runs.put(interrupted);
      world.fdb.close();

      // Generation 2 serves it unchanged: still RUNNING, not 404,
      // not dressed up as finished.
      const world2 = makeWorld(file, false);
      try {
        setRuntimeRunStore(world2.fdb.runs);
        const got = await call(world2, 'GET', '/api/runtime/runs/interrupted-run');
        assert.equal(got.status, 200);
        assert.deepEqual(got.body, interrupted);
      } finally {
        world2.fdb.close();
      }
    } finally {
      setRuntimeRunStore(new InMemoryRuntimeRunStore());
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
