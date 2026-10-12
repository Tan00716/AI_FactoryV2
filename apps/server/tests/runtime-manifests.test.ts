/**
 * Run manifests (Batch 15) — one accountability record per HTTP run.
 *
 * What this pins:
 *  1. A completed run's manifest reconciles field-for-field against
 *     every surface it summarizes: the run record (identity, times,
 *     terminal state), the RUNTIME_RUN_STARTED grant (grantedTools),
 *     the intent store (ids + status buckets), the run's evidence
 *     (count/byType), the checkpoint log (count + step range), the
 *     budget limits the route actually builds (loop budgets +
 *     DEFAULT_EXTENDED_BUDGETS), and the context-manifest hash —
 *     recomputed through the checkpoint capture's own assembly and
 *     matched against the run's actual checkpoints, so the manifest
 *     provably uses the same hash, not a second invention.
 *  2. Denied tools are accounted honestly: with no allowlist the
 *     grant is empty and the denied call lands in the DENIED intent
 *     bucket (never EXECUTED); with a partial grant, the granted
 *     tool EXECUTED and the ungranted one DENIED side by side.
 *  3. The driver is named truthfully: caller script vs the route's
 *     default script; and with a routeRequest, the manifest's model
 *     is the router's primary (checked against the model-router's
 *     own route() as an independent oracle), modelSource
 *     'model-router', and the evidence accounting includes the
 *     runner's model_routing record (the run record's sink list
 *     does not carry it — count is exactly one more).
 *  4. Legacy honesty: a run record written directly into the store
 *     (the pre-manifest shape of the world) has NO manifest — its
 *     manifest query answers 404 'run manifest not found', and an
 *     unknown run answers 404 'run not found'. Nothing backfills.
 *  5. Cross-restart: the manifest survives a DB close/reopen
 *     field-for-field, and the Final Report's runs section joins it
 *     in (withManifest counted, manifest fields surfaced); a
 *     project whose tasks never ran reports the section as 无数据.
 *
 * Tests import the route from src (like runtime-checkpoints.test.ts).
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
import {
  FactoryDatabase,
  InMemoryRunManifestStore,
  InMemoryRuntimeRunStore,
  type RunManifest,
} from '@ai-factory/db';
import {
  CheckpointLog,
  DEFAULT_EXTENDED_BUDGETS,
} from '@ai-factory/runtime';
import { route } from '@ai-factory/model-router';
import {
  RUNTIME_TOOLS_ENV,
  RUN_LOOP_BUDGETS,
  assembleRunCheckpoint,
  getRuntimeManifest,
  handleRuntimeRoutes,
  listRuntimeCheckpoints,
  setRuntimeCheckpointLog,
  setRuntimeManifestStore,
  setRuntimeRunStore,
  type RuntimeRunRecord,
} from '../src/routes/runtime.ts';
import {
  generateFinalReport,
  renderFinalReportMarkdown,
} from '../src/routes/final-report.ts';
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

const MIXED_SCRIPT = [
  {
    text: 'acting',
    toolCalls: [
      { tool: 'echo', args: { msg: 'hi' } },
      { tool: 'add', args: { a: 1, b: 2 } },
    ],
  },
  { text: 'verifying', toolCalls: [] },
];

const ROUTE_REQUEST = {
  taskType: 'coding' as const,
  complexity: 4 as const,
  requiredTools: [] as string[],
  latencyPref: 'low' as const,
  costPref: 'high' as const,
  privacy: 'internal' as const,
  needsReasoning: true,
  contextNeeded: 'large' as const,
  needsVision: false,
  currentUsage: { usedPct: 12 },
};

function countByType(entries: readonly { type: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/* ------------------------------------------------------------- tests -- */

describe('runtime run manifests (Batch 15)', () => {
  it('a completed run’s manifest reconciles against every surface it summarizes', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'a.db'));
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

        const res = await call(world, 'GET', `/api/runtime/runs/${runId}/manifest`);
        assert.equal(res.status, 200);
        const m = res.body as RunManifest;
        // The HTTP surface serves exactly what the durable store holds.
        assert.deepEqual(m, world.fdb.runManifests.get(runId));
        assert.deepEqual(m, getRuntimeManifest(runId));

        // Identity — against the run record and the seeded world.
        assert.equal(m.runId, runId);
        assert.equal(m.agentId, world.agent.id);
        assert.equal(m.taskId, world.task.id);
        assert.equal(m.projectId, 'p1');
        assert.equal(m.createdAt, rec.createdAt);

        // Driver + grant — against the POST and the audited grant.
        assert.deepEqual(m.driver, {
          kind: 'script',
          adapter: 'stub',
          routeRequestProvided: false,
        });
        assert.deepEqual(m.grantedTools, ['echo']);
        const started = world.audit
          .list()
          .filter((r) => r.action === 'RUNTIME_RUN_STARTED' && r.entityId === runId);
        assert.equal(started.length, 1);
        assert.deepEqual(started[0].details['grantedTools'], m.grantedTools);

        // Budget limits — the loop budgets the route builds and the
        // extended defaults the tracker was built from.
        assert.deepEqual(m.budgetLimits.loop, { ...RUN_LOOP_BUDGETS });
        assert.deepEqual(m.budgetLimits.extended, { ...DEFAULT_EXTENDED_BUDGETS });

        // Context hash — recomputed through the checkpoint capture's
        // own assembly, and equal to the hash on the run's real
        // checkpoints (one assembly, two surfaces).
        const expectedHash = assembleRunCheckpoint({
          runId,
          stepPosition: 1,
          agent: world.agent,
          task: world.task,
          grantedTools: ['echo'],
          budgetUsage: {},
          activeTools: [],
          pendingApprovals: [],
        }).contextManifestHash;
        assert.equal(m.contextManifestHash, expectedHash);
        const checkpoints = listRuntimeCheckpoints(runId);
        assert.ok(checkpoints.length > 0);
        for (const c of checkpoints) assert.equal(c.contextManifestHash, m.contextManifestHash);

        // Terminal accounting — against the run record.
        assert.equal(m.status, rec.status);
        assert.equal(m.outcome, rec.outcome);
        assert.equal(m.finishedAt, rec.finishedAt);
        assert.equal(m.error, null);
        assert.equal(m.steps, rec.steps);

        // Model: no routeRequest — the OBSERVE evidence's adapter
        // name, sourced 'adapter'. Never dressed up as a real model.
        assert.equal(m.model, 'stub');
        assert.equal(m.modelSource, 'adapter');

        // Budget usage — the run's tracker facts (one ACT: one
        // model call, one tool call).
        assert.equal(m.budgetUsage?.modelCalls, 1);
        assert.equal(m.budgetUsage?.toolCalls, 1);
        assert.equal(m.budgetUsage?.repairLoops, 0);
        assert.equal(m.budgetUsage?.noProgressSteps, 0);
        assert.ok(typeof m.budgetUsage?.elapsedMs === 'number' && m.budgetUsage.elapsedMs >= 0);

        // Intents — against the shared store, ids and buckets.
        const intents = world.fdb.stepIntents.listIntents(runId);
        assert.equal(m.intents?.total, intents.length);
        assert.deepEqual(m.intents?.ids, intents.map((i) => i.id));
        assert.deepEqual(m.intents?.byStatus, { PENDING: 0, EXECUTED: 1, FAILED: 0, DENIED: 0 });

        // Evidence — against the run record's evidence list.
        const recEvidence = rec.evidence as { type: string }[];
        assert.equal(m.evidence?.count, recEvidence.length);
        assert.deepEqual(m.evidence?.byType, countByType(recEvidence));

        // Checkpoints — against the checkpoint log's read surface.
        assert.equal(m.checkpoints?.count, checkpoints.length);
        assert.equal(m.checkpoints?.count, rec.steps);
        assert.equal(m.checkpoints?.firstStep, 1);
        assert.equal(m.checkpoints?.lastStep, rec.steps);

        // No manifest write failed along the way.
        assert.equal(
          world.audit.list().filter((r) => r.action === 'RUNTIME_MANIFEST_FAILED').length,
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

  it('a denied tool is accounted as DENIED with an empty grant, never as executed', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist(undefined);
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'b.db'));
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

        const m = getRuntimeManifest(runId);
        assert.ok(m);
        assert.deepEqual(m.grantedTools, []);
        const intents = world.fdb.stepIntents.listIntents(runId);
        assert.equal(intents.length, 1);
        assert.equal(intents[0].status, 'DENIED');
        assert.deepEqual(m.intents?.ids, intents.map((i) => i.id));
        assert.deepEqual(m.intents?.byStatus, { PENDING: 0, EXECUTED: 0, FAILED: 0, DENIED: 1 });
        // The tool never ran, so the tracker's tool-call count is 0
        // even though the manifest honestly records the attempt.
        assert.equal(m.budgetUsage?.toolCalls, 0);
        assert.equal(m.status, 'COMPLETED');
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a partial grant accounts EXECUTED and DENIED side by side', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'c.db'));
      installWorld(world);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
          script: MIXED_SCRIPT,
        });
        assert.equal(post.status, 202);
        const runId = (post.body as { id: string }).id;
        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');

        const m = getRuntimeManifest(runId);
        assert.ok(m);
        assert.deepEqual(m.grantedTools, ['echo']);
        const intents = world.fdb.stepIntents.listIntents(runId);
        assert.equal(intents.length, 2);
        assert.deepEqual(m.intents?.ids, intents.map((i) => i.id));
        assert.deepEqual(m.intents?.byStatus, { PENDING: 0, EXECUTED: 1, FAILED: 0, DENIED: 1 });
        const byTool = new Map(intents.map((i) => [i.tool, i.status]));
        assert.equal(byTool.get('echo'), 'EXECUTED');
        assert.equal(byTool.get('add'), 'DENIED');
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default script is named as the driver when the POST carries none', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'd.db'));
      installWorld(world);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
        });
        assert.equal(post.status, 202);
        const runId = (post.body as { id: string }).id;
        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');
        const m = getRuntimeManifest(runId);
        assert.ok(m);
        assert.equal(m.driver.kind, 'default-script');
        assert.equal(m.driver.adapter, 'stub');
        assert.equal(m.driver.routeRequestProvided, false);
        assert.equal(m.status, 'COMPLETED');
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a routeRequest names the router’s primary as the model, sourced model-router', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'e.db'));
      installWorld(world);
      try {
        const post = await call(world, 'POST', '/api/runtime/runs', {
          agentId: world.agent.id,
          taskId: world.task.id,
          script: ECHO_SCRIPT,
          routeRequest: ROUTE_REQUEST,
        });
        assert.equal(post.status, 202);
        const runId = (post.body as { id: string }).id;
        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');

        const m = getRuntimeManifest(runId);
        assert.ok(m);
        assert.equal(m.driver.routeRequestProvided, true);
        // Independent oracle: the model-router's own decision for
        // the same request.
        const decision = route(ROUTE_REQUEST as never);
        assert.ok(decision.primary !== null);
        assert.equal(m.model, decision.primary?.model);
        assert.equal(m.modelSource, 'model-router');
        // The evidence accounting includes the runner's routing
        // record — exactly one entry more than the run record's
        // sink-fed list carries.
        const recEvidence = rec.evidence as { type: string }[];
        assert.equal(m.evidence?.byType['model_routing'], 1);
        assert.equal(m.evidence?.count, recEvidence.length + 1);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a legacy run without a manifest answers an honest 404 — nothing backfilled', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    try {
      const world = makeWorld(join(dir, 'f.db'));
      installWorld(world);
      try {
        // A run record in exactly the shape the route's creation
        // write persists — but written directly, as every run before
        // the manifest wiring was. No manifest row exists for it.
        const legacy: RuntimeRunRecord = {
          id: 'legacy-run',
          agentId: world.agent.id,
          taskId: world.task.id,
          status: 'COMPLETED',
          outcome: 'completed',
          steps: 6,
          evidence: [],
          handoffs: [],
          trace: [],
          createdAt: '2026-10-01T00:00:00.000Z',
          finishedAt: '2026-10-01T00:01:00.000Z',
          error: null,
        };
        world.fdb.runs.put(legacy);
        assert.equal(world.fdb.runManifests.get('legacy-run'), undefined);

        const runRes = await call(world, 'GET', '/api/runtime/runs/legacy-run');
        assert.equal(runRes.status, 200);
        const manRes = await call(world, 'GET', '/api/runtime/runs/legacy-run/manifest');
        assert.equal(manRes.status, 404);
        assert.equal((manRes.body as { error: string }).error, 'run manifest not found');
        // The 404 did not conjure a manifest into existence.
        assert.equal(world.fdb.runManifests.get('legacy-run'), undefined);

        const unknownRes = await call(world, 'GET', '/api/runtime/runs/no-such-run/manifest');
        assert.equal(unknownRes.status, 404);
        assert.equal((unknownRes.body as { error: string }).error, 'run not found');
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the manifest survives a restart field-for-field and feeds the Final Report', { timeout: 20_000 }, async () => {
    const restoreEnv = withAllowlist('echo');
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-manifest-'));
    const file = join(dir, 'g.db');
    let manifestA: RunManifest | undefined;
    let runId = '';
    let stepsA = 0;
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
        runId = (post.body as { id: string }).id;
        const rec = await waitForRun(world, runId);
        assert.equal(rec.status, 'COMPLETED');
        stepsA = rec.steps;
        const res = await call(world, 'GET', `/api/runtime/runs/${runId}/manifest`);
        assert.equal(res.status, 200);
        manifestA = res.body as RunManifest;
      } finally {
        world.fdb.close();
      }

      // Generation 2 over the same file: the manifest is served back
      // identical, and the Final Report joins it in.
      const world2 = makeWorld(file, false);
      try {
        installWorld(world2);
        const res = await call(world2, 'GET', `/api/runtime/runs/${runId}/manifest`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, manifestA);

        const report = generateFinalReport(world2.fdb, 'p1');
        assert.ok(report);
        assert.equal(report.extensions.runs.available, true);
        assert.equal(report.extensions.runs.total, 1);
        assert.equal(report.extensions.runs.withManifest, 1);
        assert.equal(report.extensions.runs.withoutManifest, 0);
        assert.deepEqual(report.extensions.runs.byStatus, { COMPLETED: 1 });
        assert.equal(report.extensions.sectionStatus['runs'], 'ok');
        assert.equal(report.metrics['runsTotal'], 1);
        assert.equal(report.metrics['runsWithManifest'], 1);
        const item = report.extensions.runs.items[0];
        assert.equal(item.runId, runId);
        assert.equal(item.status, 'COMPLETED');
        assert.equal(item.manifest?.projectId, 'p1');
        assert.equal(item.manifest?.driverKind, 'script');
        assert.equal(item.manifest?.adapter, 'stub');
        assert.equal(item.manifest?.model, 'stub');
        assert.equal(item.manifest?.modelSource, 'adapter');
        assert.deepEqual(item.manifest?.grantedTools, ['echo']);
        assert.equal(item.manifest?.contextManifestHash, manifestA?.contextManifestHash);
        assert.equal(item.manifest?.intentsTotal, 1);
        assert.equal(item.manifest?.intentsByStatus?.DENIED, 0);
        assert.equal(item.manifest?.evidenceCount, manifestA?.evidence?.count);
        assert.equal(item.manifest?.checkpointCount, stepsA);
        assert.deepEqual(item.manifest?.checkpointRange, { firstStep: 1, lastStep: stepsA });
        const md = renderFinalReportMarkdown(report);
        assert.match(md, /## 运行记录（Runs）/);
        assert.ok(md.includes(runId));

        // A project whose tasks never ran: the section is honestly
        // empty, not padded.
        world2.fdb.createProject({ id: 'p2', name: 'P2', description: '', path: '' });
        world2.tasks.create({
          projectId: 'p2',
          title: 'T2',
          goal: 'g2',
          description: '',
          priority: 'P2',
          acceptanceCriteria: [],
          constraints: [],
          creator: 'human',
        });
        const empty = generateFinalReport(world2.fdb, 'p2');
        assert.ok(empty);
        assert.equal(empty.extensions.runs.available, false);
        assert.match(empty.extensions.runs.note ?? '', /无数据/);
        assert.equal(empty.extensions.runs.total, 0);
        assert.equal(empty.extensions.sectionStatus['runs'], 'no-data');
        assert.equal(empty.metrics['runsTotal'], 0);
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
