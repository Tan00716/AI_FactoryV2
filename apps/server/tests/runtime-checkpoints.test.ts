/**
 * Run checkpoints (§28.3) — the run path as first production consumer
 * (Batch 13).
 *
 * What this pins:
 *  1. A real HTTP run captures ONE checkpoint per executed loop step
 *     into the durable (SQLite) CheckpointLog: the AgentLoop's
 *     onTrace fires exactly once per executed phase step, so the
 *     captures' stepPositions are 1..run.steps with no gaps, and the
 *     fields are the run's real facts — budget usage from the run's
 *     BudgetTracker (0 model calls before ACT, 1 after), active tools
 *     from the run's committed step intents, the context-manifest
 *     hash stable across the run, no invented optional fields.
 *  2. A tool the permission gate DENIED never shows up as an active
 *     tool in any checkpoint (its intent is DENIED — the tool never
 *     ran), while the run still captures every step.
 *  3. The interruption chain: a run abandoned mid-step (its loop is
 *     parked inside ACT and never completes — the in-process shape of
 *     a killed process) leaves its run record RUNNING and its last
 *     checkpoint readable after the database is closed and reopened
 *     under a new FactoryDatabase: GET checkpoints/latest serve the
 *     recovery point field-for-field, and nothing auto-resumes (the
 *     record stays RUNNING, no new captures appear). The record is
 *     written through the production run store in exactly the shape
 *     the route's creation write persists — the state a kill leaves
 *     behind (same simulation precedent as runtime-runs-persistence);
 *     the captures themselves come from the production capture
 *     factory driving a real AgentLoop/runAgent.
 *  4. End to end on the real compiled server: /api/health's
 *     checkpoints.stored starts at 0, grows to the run's step count
 *     as the run captures, and is unchanged after a SIGKILL + reboot,
 *     with the latest checkpoint served back identical over HTTP.
 *
 * Tests 1–3 import the route from src (like runtime-intents.test.ts);
 * test 4 requires the workspace build (the server under test is
 * dist/index.js), same precondition as first-run-walkthrough.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
} from '@ai-factory/core';
import { FactoryDatabase, InMemoryRuntimeRunStore } from '@ai-factory/db';
import {
  AgentLoop,
  CheckpointLog,
  Harness,
  StubAdapter,
  runAgent,
  type CheckpointV2,
  type StepFn,
} from '@ai-factory/runtime';
import {
  RUNTIME_TOOLS_ENV,
  RUN_WORKFLOW_VERSION,
  assembleRunCheckpoint,
  createRunCheckpointCapture,
  handleRuntimeRoutes,
  latestRuntimeCheckpoint,
  listRuntimeCheckpoints,
  setRuntimeCheckpointLog,
  setRuntimeRunStore,
  type RuntimeRunRecord,
} from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';

/* ------------------------------------------------------------ world -- */

function makeWorld(file: string, seed = true) {
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
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

/** The coordinator's installs, exactly as apps/server/src/index.ts performs them. */
function installWorld(world: ReturnType<typeof makeWorld>): void {
  setRuntimeRunStore(world.fdb.runs);
  setRuntimeCheckpointLog(new CheckpointLog({ store: world.fdb.checkpoints }));
}

function resetInstalls(): void {
  setRuntimeRunStore(new InMemoryRuntimeRunStore());
  setRuntimeCheckpointLog(new CheckpointLog());
}

function withAllowlist(value: string | undefined): () => void {
  const prev = process.env[RUNTIME_TOOLS_ENV];
  if (value === undefined) delete process.env[RUNTIME_TOOLS_ENV];
  else process.env[RUNTIME_TOOLS_ENV] = value;
  return () => {
    if (prev === undefined) delete process.env[RUNTIME_TOOLS_ENV];
    else process.env[RUNTIME_TOOLS_ENV] = prev;
  };
}

const ECHO_SCRIPT = [
  { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hello' } }] },
  { text: 'verifying', toolCalls: [] },
];

/* ------------------------------------------------------------- tests -- */

describe('runtime run checkpoints (§28.3)', () => {
  it('a real HTTP run captures one durable checkpoint per executed step', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-ckpt-'));
    const file = join(dir, 'a.db');
    try {
      const world = makeWorld(file);
      installWorld(world);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
          script: ECHO_SCRIPT,
        });
        assert.equal(post.status, 202);
        const runId = (post.body as { id: string }).id;

        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');
        assert.ok(rec.steps > 0);

        // One capture per executed step, positions 1..steps, no gaps.
        const listRes = await call(world, 'GET', `/api/runtime/runs/${runId}/checkpoints`);
        assert.equal(listRes.status, 200);
        const checkpoints = (listRes.body as { checkpoints: CheckpointV2[] }).checkpoints;
        assert.equal(checkpoints.length, rec.steps);
        assert.deepEqual(
          checkpoints.map((c) => c.stepPosition),
          checkpoints.map((_, i) => i + 1),
        );
        // The HTTP read surface serves exactly what the durable log holds.
        assert.deepEqual(checkpoints, listRuntimeCheckpoints(runId));
        // …and what /api/health counts (checkpointLog.list().length
        // over fdb.checkpoints — the coordinator's expression).
        assert.equal(
          new CheckpointLog({ store: world.fdb.checkpoints }).list().length,
          rec.steps,
        );

        // Field truth, spot-checked across the run's life:
        const first = checkpoints[0];
        const afterAct = checkpoints[3]; // OBSERVE, UNDERSTAND, PLAN, ACT
        const latestRes = await call(
          world,
          'GET',
          `/api/runtime/runs/${runId}/checkpoints/latest`,
        );
        assert.equal(latestRes.status, 200);
        const latest = latestRes.body as CheckpointV2;
        assert.deepEqual(latest, checkpoints[checkpoints.length - 1]);
        assert.equal(latest.schemaVersion, '2.0');
        assert.equal(latest.runId, runId);
        assert.equal(latest.workflowVersion, RUN_WORKFLOW_VERSION);
        // The task was never touched by the v2 engine: its revision
        // marker is the row's updatedAt.
        assert.equal(latest.taskVersion, `task@${world.task.updatedAt}`);
        // The manifest hash is over the documented inputs (recomputed
        // through the same assembly the capture uses) and is stable
        // across the whole run.
        const expected = assembleRunCheckpoint({
          runId,
          stepPosition: 1,
          agent: world.agent,
          task: world.task,
          grantedTools: ['echo'],
          budgetUsage: {},
          activeTools: [],
          pendingApprovals: [],
        });
        assert.equal(latest.contextManifestHash, expected.contextManifestHash);
        assert.match(latest.contextManifestHash, /^[0-9a-f]{64}$/);
        for (const c of checkpoints) {
          assert.equal(c.contextManifestHash, latest.contextManifestHash);
        }
        // Budget usage is the run tracker's, live at capture time:
        // nothing consumed before ACT; one model call + one tool
        // call once ACT has executed; non-decreasing throughout.
        assert.equal(first.budgetUsage['modelCalls'], 0);
        assert.equal(first.budgetUsage['toolCalls'], 0);
        assert.equal(afterAct.budgetUsage['modelCalls'], 1);
        assert.equal(afterAct.budgetUsage['toolCalls'], 1);
        assert.equal(latest.budgetUsage['modelCalls'], 1);
        assert.equal(latest.budgetUsage['toolCalls'], 1);
        for (let i = 1; i < checkpoints.length; i++) {
          assert.ok(
            checkpoints[i].budgetUsage['modelCalls'] >= checkpoints[i - 1].budgetUsage['modelCalls'],
          );
        }
        // Active tools come from the run's committed intents: none
        // before ACT, echo from ACT on.
        assert.deepEqual(first.activeTools, []);
        assert.deepEqual(afterAct.activeTools, ['echo']);
        assert.deepEqual(latest.activeTools, ['echo']);
        // The run's intents carry THIS run's id (the route now stamps
        // it — they used to all be 'unknown-run').
        const intents = world.fdb.stepIntents.listIntents(runId);
        assert.equal(intents.length, 1);
        assert.equal(intents[0].tool, 'echo');
        assert.equal(intents[0].status, 'EXECUTED');
        // Honest absences and empties for what this path does not have.
        assert.equal('modelSessionRef' in latest, false);
        assert.equal('workspaceSnapshotHash' in latest, false);
        assert.equal('gitBase' in latest, false);
        assert.equal('gitCandidate' in latest, false);
        assert.deepEqual(latest.activeProcesses, []);
        assert.equal(latest.leaseGeneration, 0);
        assert.equal(latest.fencingToken, 0);
        assert.deepEqual(latest.pendingApprovals, []);
        assert.deepEqual(latest.pendingSideEffects, []);
        assert.equal(latest.resumePreconditions.length, 4);
        assert.ok(latest.resumePreconditions[0].includes(world.task.id));
        // No capture failed along the way.
        assert.equal(
          world.audit.list().filter((r) => r.action === 'RUNTIME_CHECKPOINT_FAILED').length,
          0,
        );
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a denied tool never becomes an active tool, but every step still captures', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist(undefined);
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-ckpt-'));
    const file = join(dir, 'b.db');
    try {
      const world = makeWorld(file);
      installWorld(world);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
          script: ECHO_SCRIPT,
        });
        assert.equal(post.status, 202);
        const runId = (post.body as { id: string }).id;
        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');

        // The denial is real: one DENIED intent under this run's id.
        const intents = world.fdb.stepIntents.listIntents(runId);
        assert.equal(intents.length, 1);
        assert.equal(intents[0].status, 'DENIED');

        const checkpoints = listRuntimeCheckpoints(runId);
        assert.equal(checkpoints.length, rec.steps);
        for (const c of checkpoints) assert.deepEqual(c.activeTools, []);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interrupted run leaves its latest checkpoint as the recovery point after a restart', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-ckpt-'));
    const file = join(dir, 'c.db');
    const runId = randomUUID();
    let capturesA: CheckpointV2[] = [];
    let latestA: CheckpointV2 | undefined;
    let recordA: RuntimeRunRecord | undefined;
    try {
      // Generation 1: a run starts (record persisted RUNNING, exactly
      // the route's creation write), executes three steps, and its
      // loop parks inside ACT forever — the process "dies" there:
      // the runAgent promise is abandoned, never awaited, and the DB
      // is closed under it. Captures come from the production factory
      // on a real AgentLoop driven by runAgent.
      const world = makeWorld(file);
      installWorld(world);
      const { ctx } = makeCtx(world, {});
      recordA = {
        id: runId,
        agentId: world.agent.id,
        taskId: world.task.id,
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
      world.fdb.runs.put(recordA);
      const harness = new Harness({
        allowedRoots: [join(dir, 'sandbox')],
        stepTimeoutMs: 5000,
        evidence: { collect: () => {} },
      });
      const loop = new AgentLoop({
        budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 3 },
        onTrace: createRunCheckpointCapture({
          ctx,
          runId,
          agentId: world.agent.id,
          taskId: world.task.id,
          agentSnapshot: world.agent,
          taskSnapshot: world.task,
          grantedTools: [],
          harness,
        }),
      });
      const stepFn: StepFn = async (phase) => {
        if (phase === 'ACT') await new Promise(() => {});
        return { ok: true, note: `phase ${phase}` };
      };
      const abandoned = runAgent({
        agent: world.agent,
        task: world.task,
        harness,
        adapter: new StubAdapter([{ text: 'unused', toolCalls: [] }]),
        loop,
        stepFn,
        intentStore: world.fdb.stepIntents,
      });
      abandoned.catch(() => {});
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (listRuntimeCheckpoints(runId).length >= 3) break;
        if (Date.now() > deadline) throw new Error('captures did not land in 10000ms');
        await new Promise((res) => setTimeout(res, 25));
      }
      capturesA = listRuntimeCheckpoints(runId);
      latestA = latestRuntimeCheckpoint(runId);
      assert.deepEqual(
        capturesA.map((c) => c.stepPosition),
        [1, 2, 3],
      );
      assert.equal(latestA?.stepPosition, 3);
      // The custom StepFn consumes nothing: the budget facts are the
      // tracker's real zeros (elapsedMs aside).
      assert.equal(latestA?.budgetUsage['modelCalls'], 0);
      assert.equal(latestA?.budgetUsage['toolCalls'], 0);
      assert.deepEqual(latestA?.activeTools, []);
      world.fdb.close();

      // Generation 2 over the same file: the recovery read surface.
      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        const runRes = await call(world2, 'GET', `/api/runtime/runs/${runId}`);
        assert.equal(runRes.status, 200);
        // Still RUNNING, served as-is — nothing auto-resumed it.
        assert.deepEqual(runRes.body, recordA);

        const listRes = await call(world2, 'GET', `/api/runtime/runs/${runId}/checkpoints`);
        assert.equal(listRes.status, 200);
        assert.deepEqual((listRes.body as { checkpoints: CheckpointV2[] }).checkpoints, capturesA);

        const latestRes = await call(
          world2,
          'GET',
          `/api/runtime/runs/${runId}/checkpoints/latest`,
        );
        assert.equal(latestRes.status, 200);
        assert.deepEqual(latestRes.body, latestA);
        // Reading the recovery point created nothing new.
        assert.equal(listRuntimeCheckpoints(runId).length, 3);
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------- real server (dist) e2e -- */

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in extraEnv)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function waitForRunHttp(port: number, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    const rec = r.body as unknown as RuntimeRunRecord;
    if (rec.status !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe('runtime checkpoints on the real server (§28.3)', () => {
  it('health count grows with real captures and survives a kill + reboot', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-ckpt-e2e-'));
    const dbFile = join(dir, 'factory.db');
    try {
      // Boot A: fresh DB — no checkpoints; a run captures per step.
      const a = await bootServer(dbFile, { FACTORY_RUNTIME_TOOLS: 'echo' });
      let steps = 0;
      let latestA: unknown;
      try {
        const health0 = await api(a.port, 'GET', '/api/health');
        assert.equal(
          (health0.body['checkpoints'] as { stored: number }).stored,
          0,
        );
        const project = await api(a.port, 'POST', '/api/projects', {
          name: 'Checkpoint Demo',
          description: 'batch 13 e2e',
        });
        assert.equal(project.status, 201);
        const agent = await api(a.port, 'POST', '/api/agents', {
          name: 'checker',
          jobTitle: 'Engineer',
        });
        assert.equal(agent.status, 201);
        const task = await api(a.port, 'POST', '/api/tasks', {
          projectId: project.body['id'],
          title: 'Capture checkpoints',
          goal: 'one checkpoint per executed step',
        });
        assert.equal(task.status, 201);

        const run = await api(a.port, 'POST', '/api/runtime/runs', {
          agentId: agent.body['id'],
          taskId: task.body['id'],
          script: ECHO_SCRIPT,
        });
        assert.equal(run.status, 202);
        const runId = run.body['id'] as string;
        const rec = await waitForRunHttp(a.port, runId);
        assert.equal(rec.status, 'COMPLETED');
        steps = rec.steps;
        assert.ok(steps > 0);

        const list = await api(a.port, 'GET', `/api/runtime/runs/${runId}/checkpoints`);
        assert.equal(list.status, 200);
        assert.equal((list.body['checkpoints'] as unknown[]).length, steps);

        const latest = await api(
          a.port,
          'GET',
          `/api/runtime/runs/${runId}/checkpoints/latest`,
        );
        assert.equal(latest.status, 200);
        assert.equal((latest.body as unknown as CheckpointV2).stepPosition, steps);
        latestA = latest.body;

        // The health count grew from 0 to exactly the run's captures.
        const health1 = await api(a.port, 'GET', '/api/health');
        assert.equal(
          (health1.body['checkpoints'] as { stored: number }).stored,
          steps,
        );
      } finally {
        await killServer(a);
      }

      // Boot B over the same file (the crash's restart): the count
      // and the recovery point are still there, identical.
      const b = await bootServer(dbFile);
      try {
        const health = await api(b.port, 'GET', '/api/health');
        assert.equal(
          (health.body['checkpoints'] as { stored: number }).stored,
          steps,
        );
        const runId = (latestA as CheckpointV2).runId;
        const latest = await api(
          b.port,
          'GET',
          `/api/runtime/runs/${runId}/checkpoints/latest`,
        );
        assert.equal(latest.status, 200);
        assert.deepEqual(latest.body, latestA);
        const list = await api(b.port, 'GET', `/api/runtime/runs/${runId}/checkpoints`);
        assert.equal((list.body['checkpoints'] as unknown[]).length, steps);
      } finally {
        await killServer(b);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
