/**
 * Checkpoint resume (§28.4) — Batch 15.
 *
 * What this pins:
 *  1. The success path across a restart: an interrupted run (record
 *     left RUNNING, three checkpoints captured by the production
 *     capture factory from a real AgentLoop whose StepFn parks inside
 *     ACT — the in-process shape of a killed process, same simulation
 *     precedent as runtime-checkpoints) is resumed in a NEW process
 *     generation over the same DB file. The resume creates a new run:
 *     the response reports every revalidation check ok, the budget
 *     baseline is the source checkpoint's budgetUsage verbatim, the
 *     new run's checkpoints continue at source stepPosition + 1 with
 *     budget counts building on the baseline, the new run's record
 *     carries a resume_link evidence entry, its manifest accounts
 *     the continued step range, and RESUME_REQUESTED / RESUME_STARTED
 *     are audited with the old↔new linkage. The source run is left
 *     exactly as it was — still RUNNING, no new captures.
 *  2–5. One rejection per revalidation item, each asserting the
 *     per-item report (all items are reported, not fail-fast), the
 *     RESUME_REJECTED audit, and zero side effects (no new run
 *     record, no new checkpoints): task-version drift, an
 *     unreconciled PENDING step intent, an archived project, and a
 *     run with no checkpoint (404) — plus an unknown run id (404,
 *     no audit).
 *  6. The live-run exclusion: pinned at the evaluateResumeChecks
 *     level with the injected isLive seam, because a route-started
 *     run cannot be parked deterministically (scripts execute
 *     instantly — there is no HTTP-reachable "hold this run open"
 *     control), so a route-level live test would be a race. The
 *     route itself consults the module's live set, which
 *     executeRuntimeRun maintains; the not-live branch over a
 *     RUNNING leftover record is exercised by every other test here.
 *  7. A terminal FAILED run with checkpoints is resumable (it is
 *     not live, and §28.4 recovery is not limited to kill leftovers).
 *
 * Tests import the route from src (like runtime-checkpoints.test.ts).
 * The ctx carries archivedTaskBody exactly as the coordinator
 * injects it in index.ts (the evaluator semantics of
 * routes/project-guard.ts, expressed over the same fdb).
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
import {
  FactoryDatabase,
  InMemoryRunManifestStore,
  InMemoryRuntimeRunStore,
} from '@ai-factory/db';
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
  assembleRunCheckpoint,
  createRunCheckpointCapture,
  evaluateResumeChecks,
  getRuntimeManifest,
  handleRuntimeRoutes,
  isRuntimeRunLive,
  latestRuntimeCheckpoint,
  listRuntimeCheckpoints,
  setRuntimeCheckpointLog,
  setRuntimeManifestStore,
  setRuntimeRunStore,
  type ResumeChecks,
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
    // The coordinator's archive-guard injection (index.ts), with the
    // evaluator semantics of routes/project-guard.ts over this fdb.
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
  setRuntimeManifestStore(world.fdb.runManifests);
}

function resetInstalls(): void {
  setRuntimeRunStore(new InMemoryRuntimeRunStore());
  setRuntimeCheckpointLog(new CheckpointLog());
  setRuntimeManifestStore(new InMemoryRunManifestStore());
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

/* ------------------------------------------------- interrupted run -- */

/**
 * Drive a real AgentLoop/runAgent whose StepFn consumes real budget
 * (2 model calls, 2 tool calls across the first three phases) and
 * then parks inside ACT forever — the in-process shape of a killed
 * process. The run record is written through the production run
 * store in exactly the shape the route's creation write persists.
 * The abandoned promise is never awaited; the caller closes the DB
 * under it. Returns after the third capture has landed.
 */
async function makeInterruptedRun(
  world: ReturnType<typeof makeWorld>,
  dir: string,
  status: 'RUNNING' | 'FAILED' = 'RUNNING',
): Promise<{ runId: string; latest: CheckpointV2 }> {
  const runId = randomUUID();
  const { ctx } = makeCtx(world, {});
  world.fdb.runs.put({
    id: runId,
    agentId: world.agent.id,
    taskId: world.task.id,
    status,
    outcome: null,
    steps: 0,
    evidence: [],
    handoffs: [],
    trace: [],
    createdAt: new Date().toISOString(),
    finishedAt: status === 'RUNNING' ? null : new Date().toISOString(),
    error: status === 'RUNNING' ? null : 'simulated crash',
  });
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
    // Real consumption through the run's real BudgetTracker (the one
    // runAgent attaches to this harness), so the captures' budgetUsage
    // is fact, not fixture paint.
    if (phase === 'OBSERVE') harness.tracker?.consumeModelCall();
    if (phase === 'UNDERSTAND') {
      harness.tracker?.consumeToolCall();
      harness.tracker?.consumeToolCall();
    }
    if (phase === 'PLAN') harness.tracker?.consumeModelCall();
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
  const latest = latestRuntimeCheckpoint(runId);
  assert.ok(latest);
  return { runId, latest };
}

/* ------------------------------------------------------------- tests -- */

describe('runtime run resume (§28.4)', () => {
  it('resumes an interrupted run into a new run carrying budget baseline and step positions', { timeout: 30_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'a.db');
    let agentId = '';
    let taskId = '';
    try {
      // Generation 1: the interrupted run and its three checkpoints.
      const world1 = makeWorld(file);
      installWorld(world1);
      agentId = world1.agent.id;
      taskId = world1.task.id;
      const { runId, latest } = await makeInterruptedRun(world1, dir);
      assert.deepEqual(
        listRuntimeCheckpoints(runId).map((c) => c.stepPosition),
        [1, 2, 3],
      );
      assert.equal(latest.stepPosition, 3);
      assert.equal(latest.budgetUsage['modelCalls'], 2);
      assert.equal(latest.budgetUsage['toolCalls'], 2);
      world1.fdb.close();

      // Generation 2 over the same file: the resume.
      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        const res = await call(world2, 'POST', `/api/runtime/runs/${runId}/resume`, {
          script: ECHO_SCRIPT,
        });
        assert.equal(res.status, 202);
        const body = res.body as {
          id: string;
          status: string;
          resumedFrom: { runId: string; stepPosition: number; capturedAt: number };
          budgetBaseline: Record<string, number>;
          checks: ResumeChecks;
        };
        const newId = body.id;
        assert.notEqual(newId, runId);
        assert.equal(body.status, 'RUNNING');
        assert.equal(isRuntimeRunLive(newId), true);
        assert.deepEqual(body.resumedFrom, {
          runId,
          stepPosition: 3,
          capturedAt: latest.capturedAt,
        });
        // The baseline is the source checkpoint's budgetUsage, verbatim.
        assert.deepEqual(body.budgetBaseline, latest.budgetUsage);
        // Every revalidation item is present and ok.
        for (const [name, check] of Object.entries(body.checks)) {
          assert.equal(check.ok, true, `check ${name} should pass: ${check.detail}`);
        }
        assert.match(body.checks.runNotLive.detail, /interrupted leftover/);

        const rec = await waitForRun(world2, newId);
        assert.equal(rec.status, 'COMPLETED');
        assert.equal(isRuntimeRunLive(newId), false);

        // Step positions continue at source+1, contiguous, one per step.
        const newCheckpoints = listRuntimeCheckpoints(newId);
        assert.equal(newCheckpoints.length, rec.steps);
        assert.deepEqual(
          newCheckpoints.map((c) => c.stepPosition),
          newCheckpoints.map((_, i) => i + 4),
        );
        // Budget counts build on the baseline: OBSERVE consumed
        // nothing yet (2/2), ACT added one model call + one executed
        // tool call (3/3).
        assert.equal(newCheckpoints[0].budgetUsage['modelCalls'], 2);
        assert.equal(newCheckpoints[0].budgetUsage['toolCalls'], 2);
        const last = newCheckpoints[newCheckpoints.length - 1];
        assert.equal(last.budgetUsage['modelCalls'], 3);
        assert.equal(last.budgetUsage['toolCalls'], 3);
        // The manifest of the resumed run accounts the continued range.
        const manifest = getRuntimeManifest(newId);
        assert.ok(manifest);
        assert.equal(manifest.status, 'COMPLETED');
        assert.equal(manifest.checkpoints?.firstStep, 4);
        assert.equal(manifest.checkpoints?.lastStep, 3 + rec.steps);
        assert.equal(manifest.budgetUsage?.modelCalls, 3);

        // The lineage is on the new run's own record.
        const links = (
          rec.evidence as Array<{
            type: string;
            payload: {
              resumeOf?: { runId: string; stepPosition: number };
              budgetBaseline?: Record<string, number>;
            };
          }>
        ).filter((e) => e.type === 'resume_link');
        assert.equal(links.length, 1);
        assert.deepEqual(links[0].payload.resumeOf, { runId, stepPosition: 3 });
        assert.deepEqual(links[0].payload.budgetBaseline, latest.budgetUsage);

        // The source run is untouched: still RUNNING, no new captures.
        const srcRes = await call(world2, 'GET', `/api/runtime/runs/${runId}`);
        assert.equal((srcRes.body as RuntimeRunRecord).status, 'RUNNING');
        assert.equal(listRuntimeCheckpoints(runId).length, 3);

        // The audit trail: requested → started, never rejected.
        const audits = world2.audit.list();
        const requested = audits.filter((r) => r.action === 'RESUME_REQUESTED');
        assert.equal(requested.length, 1);
        assert.equal(requested[0].entityId, runId);
        const started = audits.filter((r) => r.action === 'RESUME_STARTED');
        assert.equal(started.length, 1);
        assert.equal(started[0].entityId, newId);
        assert.equal(started[0].details['resumedFromRunId'], runId);
        assert.deepEqual(started[0].details['budgetBaseline'], latest.budgetUsage);
        assert.equal(
          (started[0].details['checkpoint'] as { stepPosition: number }).stepPosition,
          3,
        );
        assert.equal(audits.filter((r) => r.action === 'RESUME_REJECTED').length, 0);
        assert.equal(agentId.length > 0 && taskId.length > 0, true);
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the task changed underneath the checkpoint (version drift)', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'b.db');
    try {
      const world1 = makeWorld(file);
      installWorld(world1);
      const taskId = world1.task.id;
      const { runId, latest } = await makeInterruptedRun(world1, dir);
      world1.fdb.close();

      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        // Any task mutation bumps updatedAt — the capture-side marker
        // rule — so the task is no longer at the checkpoint's version.
        world2.tasks.setStatus(taskId, 'IN_PROGRESS');
        const res = await call(world2, 'POST', `/api/runtime/runs/${runId}/resume`, {});
        assert.equal(res.status, 409);
        const body = res.body as { reason: string; checks: ResumeChecks };
        assert.equal(body.reason, 'revalidation_failed');
        assert.equal(body.checks.taskExists.ok, true);
        assert.equal(body.checks.taskVersionCurrent.ok, false);
        assert.equal(body.checks.taskVersionCurrent.expected, latest.taskVersion);
        assert.equal(
          body.checks.taskVersionCurrent.actual,
          `task@${world2.tasks.get(taskId).updatedAt}`,
        );
        // The other items are still reported (not fail-fast).
        assert.equal(body.checks.agentRegistered.ok, true);
        assert.equal(body.checks.noPendingIntents.ok, true);
        // Zero side effects: no new run, no new checkpoints.
        assert.equal(world2.fdb.runs.list().length, 1);
        assert.equal(listRuntimeCheckpoints(runId).length, 3);
        const rejected = world2.audit
          .list()
          .filter((r) => r.action === 'RESUME_REJECTED');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].details['reason'], 'revalidation_failed');
        assert.equal(
          (rejected[0].details['checks'] as ResumeChecks).taskVersionCurrent.ok,
          false,
        );
        assert.equal(
          world2.audit.list().filter((r) => r.action === 'RESUME_STARTED').length,
          0,
        );
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the run has an unreconciled PENDING step intent', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'c.db');
    try {
      const world1 = makeWorld(file);
      installWorld(world1);
      const { runId } = await makeInterruptedRun(world1, dir);
      world1.fdb.close();

      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        // An intent persisted before a tool call whose result was
        // never committed: its outcome is UNKNOWN (§28.2).
        const intent = world2.fdb.stepIntents.persistIntent(runId, 'echo', { msg: 'x' });
        const res = await call(world2, 'POST', `/api/runtime/runs/${runId}/resume`, {});
        assert.equal(res.status, 409);
        const body = res.body as { reason: string; checks: ResumeChecks };
        assert.equal(body.reason, 'revalidation_failed');
        assert.equal(body.checks.noPendingIntents.ok, false);
        assert.deepEqual(body.checks.noPendingIntents.pending, [
          { id: intent.id, tool: 'echo' },
        ]);
        assert.equal(body.checks.taskVersionCurrent.ok, true);
        assert.equal(world2.fdb.runs.list().length, 1);
        assert.equal(listRuntimeCheckpoints(runId).length, 3);
        assert.equal(
          world2.audit.list().filter((r) => r.action === 'RESUME_REJECTED').length,
          1,
        );
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the task’s project is archived', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'd.db');
    try {
      const world1 = makeWorld(file);
      installWorld(world1);
      const { runId } = await makeInterruptedRun(world1, dir);
      world1.fdb.close();

      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        world2.fdb.setProjectStatus('p1', 'archived');
        const res = await call(world2, 'POST', `/api/runtime/runs/${runId}/resume`, {});
        assert.equal(res.status, 409);
        const body = res.body as { reason: string; checks: ResumeChecks };
        assert.equal(body.reason, 'revalidation_failed');
        assert.equal(body.checks.projectNotArchived.ok, false);
        assert.equal(body.checks.projectNotArchived.projectId, 'p1');
        // Everything else still evaluated and reported.
        assert.equal(body.checks.taskVersionCurrent.ok, true);
        assert.equal(body.checks.noPendingIntents.ok, true);
        assert.equal(world2.fdb.runs.list().length, 1);
        assert.equal(listRuntimeCheckpoints(runId).length, 3);
        assert.equal(
          world2.audit.list().filter((r) => r.action === 'RESUME_REJECTED').length,
          1,
        );
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s a run with no checkpoint (audited rejection) and an unknown run (no audit)', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'e.db');
    try {
      const world = makeWorld(file);
      installWorld(world);
      try {
        const bareId = randomUUID();
        world.fdb.runs.put({
          id: bareId,
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
        });
        const res = await call(world, 'POST', `/api/runtime/runs/${bareId}/resume`, {});
        assert.equal(res.status, 404);
        const body = res.body as { error: string; reason: string; checks: ResumeChecks };
        assert.equal(body.error, 'no checkpoint captured for run');
        assert.equal(body.reason, 'no_checkpoint');
        assert.equal(body.checks.checkpointExists.ok, false);
        const rejected = world.audit
          .list()
          .filter((r) => r.action === 'RESUME_REJECTED');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].details['reason'], 'no_checkpoint');
        assert.equal(world.fdb.runs.list().length, 1);

        const missing = randomUUID();
        const res2 = await call(world, 'POST', `/api/runtime/runs/${missing}/resume`, {});
        assert.equal(res2.status, 404);
        assert.equal((res2.body as { error: string }).error, 'run not found');
        // An unknown run leaves no audit trail at all.
        assert.equal(
          world.audit.list().filter((r) => r.entityId === missing).length,
          0,
        );
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the live-run exclusion: a live run fails runNotLive, everything else still passes', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'f.db');
    try {
      const world = makeWorld(file);
      installWorld(world);
      try {
        const runId = randomUUID();
        const rec: RuntimeRunRecord = {
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
        world.fdb.runs.put(rec);
        // One real capture through the production assembly + log.
        new CheckpointLog({ store: world.fdb.checkpoints }).capture(
          assembleRunCheckpoint({
            runId,
            stepPosition: 2,
            agent: world.agent,
            task: world.task,
            grantedTools: [],
            budgetUsage: {},
            activeTools: [],
            pendingApprovals: [],
          }),
        );
        const checkpoint = latestRuntimeCheckpoint(runId);
        assert.ok(checkpoint);
        const { ctx } = makeCtx(world, {});

        const liveChecks = evaluateResumeChecks(ctx, rec, checkpoint, { isLive: true });
        assert.equal(liveChecks.runNotLive.ok, false);
        assert.match(liveChecks.runNotLive.detail, /executing in this process/);
        for (const [name, check] of Object.entries(liveChecks)) {
          if (name === 'runNotLive') continue;
          assert.equal(check.ok, true, `check ${name} should pass: ${check.detail}`);
        }

        // The same record, not live: the leftover branch passes and
        // says what the record actually is.
        const idleChecks = evaluateResumeChecks(ctx, rec, checkpoint);
        assert.equal(idleChecks.runNotLive.ok, true);
        assert.match(idleChecks.runNotLive.detail, /interrupted leftover/);
        assert.equal(isRuntimeRunLive(runId), false);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a terminal FAILED run (not live, checkpoints present) with the default driver', { timeout: 30_000 }, async () => {
    const restoreEnv = withAllowlist(undefined);
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-resume-'));
    const file = join(dir, 'g.db');
    try {
      const world1 = makeWorld(file);
      installWorld(world1);
      const { runId, latest } = await makeInterruptedRun(world1, dir, 'FAILED');
      world1.fdb.close();

      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        const res = await call(world2, 'POST', `/api/runtime/runs/${runId}/resume`, {});
        assert.equal(res.status, 202);
        const body = res.body as { id: string; checks: ResumeChecks };
        assert.match(body.checks.runNotLive.detail, /FAILED/);
        assert.deepEqual(body.checks.noPendingIntents.pending, []);
        const rec = await waitForRun(world2, body.id);
        assert.equal(rec.status, 'COMPLETED');
        // No script in the request → the route's default script drove
        // it, and positions still continue from the source checkpoint.
        const manifest = getRuntimeManifest(body.id);
        assert.equal(manifest?.driver.kind, 'default-script');
        assert.deepEqual(
          listRuntimeCheckpoints(body.id).map((c) => c.stepPosition),
          listRuntimeCheckpoints(body.id).map((_, i) => i + latest.stepPosition + 1),
        );
      } finally {
        world2.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
