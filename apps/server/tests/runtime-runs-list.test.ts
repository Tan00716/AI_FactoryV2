/**
 * Run list join (Batch 16) — GET /api/runtime/runs as the Observatory
 * source. The bare list used to serve run records only, so a global
 * runs view would have had to fan out one manifest + one checkpoints
 * fetch per row. The join now happens server-side; this pins:
 *
 *  1. A real run's row carries the manifest's key columns (model +
 *     source, terminal accounting, intent buckets with DENIED,
 *     evidence count, budget usage), the checkpoint log's LIVE count
 *     (equal to the count the checkpoint read surface serves), the
 *     process-live flag (false once finished), and the resolved
 *     project id + name. The row's manifest is a summary: the full
 *     manifest's creation block (context hash, budget limits, grant)
 *     is NOT duplicated into the list — it stays on /:id/manifest.
 *  2. A legacy run (record written directly, pre-manifest shape)
 *     reads with manifest: null — an honest absence, nothing
 *     backfilled — while its project still resolves from the task;
 *     a record whose task is also gone resolves projectId null.
 *     Its RUNNING status is served as-is with live: false: an
 *     interrupted leftover, never reaped or rewritten by the list.
 *  3. An empty registry lists as an empty array, not an error.
 *
 * Tests import the route from src (like runtime-manifests.test.ts).
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
} from '@ai-factory/db';
import { CheckpointLog } from '@ai-factory/runtime';
import {
  RUNTIME_TOOLS_ENV,
  handleRuntimeRoutes,
  listRuntimeCheckpoints,
  setRuntimeCheckpointLog,
  setRuntimeManifestStore,
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

/** The list row shape the Observatory consumes (see listRow). */
interface ListRow extends RuntimeRunRecord {
  live: boolean;
  checkpointCount: number;
  projectId: string | null;
  projectName: string | null;
  manifest: {
    status: string;
    outcome: string | null;
    finishedAt: string | null;
    error: string | null;
    steps: number | null;
    driverKind: string;
    adapter: string;
    model: string | null;
    modelSource: string | null;
    budgetUsage: { toolCalls: number } | null;
    intentsTotal: number | null;
    intentsByStatus: { PENDING: number; EXECUTED: number; FAILED: number; DENIED: number } | null;
    evidenceCount: number | null;
  } | null;
}

async function listRows(world: ReturnType<typeof makeWorld>): Promise<ListRow[]> {
  const res = await call(world, 'GET', '/api/runtime/runs');
  assert.equal(res.status, 200);
  return (res.body as { runs: ListRow[] }).runs;
}

/* ------------------------------------------------------------- tests -- */

describe('runtime run list join (Batch 16)', () => {
  it('a real run’s row joins its manifest key columns, live checkpoint count and project', { timeout: 20_000 }, async () => {
    // No allowlist: the echo call is DENIED — the row must surface
    // that in the intent buckets, not hide it.
    const restoreEnv = withAllowlist(undefined);
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-runlist-'));
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

        const rows = await listRows(world);
        assert.equal(rows.length, 1);
        const row = rows[0];

        // The run record itself rides along unchanged.
        assert.equal(row.id, runId);
        assert.equal(row.agentId, world.agent.id);
        assert.equal(row.taskId, world.task.id);
        assert.equal(row.status, 'COMPLETED');
        assert.equal(row.createdAt, rec.createdAt);
        assert.equal(row.finishedAt, rec.finishedAt);

        // Live flag: a finished run is not executing in this process.
        assert.equal(row.live, false);

        // Checkpoint count is the log's live count — the same number
        // the checkpoint read surface serves for this run.
        const checkpoints = listRuntimeCheckpoints(runId);
        assert.ok(checkpoints.length > 0);
        assert.equal(row.checkpointCount, checkpoints.length);
        assert.equal(row.checkpointCount, rec.steps);

        // Project resolved (manifest snapshot / task agree here).
        assert.equal(row.projectId, 'p1');
        assert.equal(row.projectName, 'P');

        // Manifest key columns — against the durable manifest and
        // the run's own records.
        const m = world.fdb.runManifests.get(runId);
        assert.ok(m);
        assert.ok(row.manifest);
        assert.equal(row.manifest.status, m.status);
        assert.equal(row.manifest.outcome, rec.outcome);
        assert.equal(row.manifest.finishedAt, rec.finishedAt);
        assert.equal(row.manifest.error, null);
        assert.equal(row.manifest.steps, rec.steps);
        assert.equal(row.manifest.driverKind, 'script');
        assert.equal(row.manifest.adapter, 'stub');
        assert.equal(row.manifest.model, 'stub');
        assert.equal(row.manifest.modelSource, 'adapter');
        assert.equal(row.manifest.budgetUsage?.toolCalls, 0);
        // The denied call is accounted in the row's buckets.
        assert.equal(row.manifest.intentsTotal, 1);
        assert.deepEqual(row.manifest.intentsByStatus, {
          PENDING: 0, EXECUTED: 0, FAILED: 0, DENIED: 1,
        });
        assert.equal(row.manifest.evidenceCount, (rec.evidence as unknown[]).length);

        // The summary is NOT the full manifest: the creation block
        // stays on GET /:id/manifest alone.
        const summary = row.manifest as unknown as Record<string, unknown>;
        assert.equal('contextManifestHash' in summary, false);
        assert.equal('budgetLimits' in summary, false);
        assert.equal('grantedTools' in summary, false);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a legacy run without a manifest lists manifest: null and resolves what it honestly can', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-runlist-'));
    try {
      const world = makeWorld(join(dir, 'b.db'));
      installWorld(world);
      try {
        // A pre-manifest run record, written directly in exactly the
        // shape the route's creation write persists — left RUNNING,
        // as a killed process leaves it.
        const legacy: RuntimeRunRecord = {
          id: 'legacy-run',
          agentId: world.agent.id,
          taskId: world.task.id,
          status: 'RUNNING',
          outcome: null,
          steps: 3,
          evidence: [],
          handoffs: [],
          trace: [],
          createdAt: '2026-10-01T00:00:00.000Z',
          finishedAt: null,
          error: null,
        };
        world.fdb.runs.put(legacy);
        // A record whose task is gone too: nothing may be invented
        // for it either.
        world.fdb.runs.put({
          ...legacy,
          id: 'orphan-run',
          taskId: 'task-that-no-longer-exists',
        });
        assert.equal(world.fdb.runManifests.get('legacy-run'), undefined);

        const rows = await listRows(world);
        assert.equal(rows.length, 2);
        const byId = new Map(rows.map((r) => [r.id, r]));

        const row = byId.get('legacy-run');
        assert.ok(row);
        // Honest absence: no manifest, no counts conjured up; the
        // record stands exactly as it was left.
        assert.equal(row.manifest, null);
        assert.equal(row.checkpointCount, 0);
        assert.equal(row.status, 'RUNNING');
        assert.equal(row.live, false);
        // The project still resolves from the surviving task.
        assert.equal(row.projectId, 'p1');
        assert.equal(row.projectName, 'P');

        const orphan = byId.get('orphan-run');
        assert.ok(orphan);
        assert.equal(orphan.manifest, null);
        assert.equal(orphan.projectId, null);
        assert.equal(orphan.projectName, null);

        // Listing invented nothing: still no manifest rows exist.
        assert.equal(world.fdb.runManifests.get('legacy-run'), undefined);
        assert.equal(world.fdb.runManifests.list().length, 0);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty registry lists as an empty array', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-runlist-'));
    try {
      const world = makeWorld(join(dir, 'c.db'));
      installWorld(world);
      try {
        assert.deepEqual(await listRows(world), []);
      } finally {
        world.fdb.close();
      }
    } finally {
      resetInstalls();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
