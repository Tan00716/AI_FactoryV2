/**
 * Runtime route step-intent wiring — SPEC v2 §28.1 (G-59, Batch 9).
 *
 * What this pins:
 *  1. The route forwards ctx.stepIntentStore into runAgent. Proof uses
 *     a counting store: runAgent consults the effective store for its
 *     intentSummary baseline (listIntents) on every run, so a completed
 *     run must have touched the injected store — with runAgent's own
 *     fresh in-memory default, the counter would stay at zero.
 *  2. The store the coordinator injects (fdb.stepIntents, SQLite) works
 *     in the real run path: a tool call that passes the harness
 *     permission gate lands in step_intents as EXECUTED and is still
 *     there after the database is closed and reopened.
 *
 * Why test 2 configures toolPermissions instead of going through the
 * route's own toolset: the route's toy tools (echo/add) are not in the
 * harness's DEFAULT_TOOL_PERMISSIONS and the route passes no
 * toolPermissions override, so the fail-closed gate denies them before
 * any intent is persisted (checkPermission precedes persistIntent in
 * Harness.runTool). That is pre-existing route behavior — the gate
 * working as designed — not something this wiring changes. Test 2 uses
 * the harness's supported override, exactly as runtime's own harness
 * tests do, with the same store object index.ts injects.
 *
 * Imports the route from src (like watchdog-routes.test.ts); the route
 * module's value imports are package names + builtins only, which
 * Node's type-stripping loader handles.
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
import { FactoryDatabase } from '@ai-factory/db';
import {
  AgentLoop,
  Harness,
  StepIntentStore,
  StubAdapter,
  runAgent,
  type StepIntent,
} from '@ai-factory/runtime';
import { getRuntimeRun, handleRuntimeRoutes } from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';

class CountingStore extends StepIntentStore {
  listCalls = 0;
  persistCalls = 0;
  override listIntents(runId?: string): StepIntent[] {
    this.listCalls++;
    return super.listIntents(runId);
  }
  override persistIntent(
    runId: string,
    tool: string,
    args: unknown,
    capabilityRef?: string,
  ): StepIntent {
    this.persistCalls++;
    return super.persistIntent(runId, tool, args, capabilityRef);
  }
}

async function waitForRun(id: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = getRuntimeRun(id);
    if (rec && rec.status !== 'RUNNING') return rec.status;
    if (Date.now() > deadline) throw new Error(`run ${id} did not finish in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeWorld(file: string) {
  const fdb = new FactoryDatabase(file);
  fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
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

describe('runtime step-intent wiring (G-59)', () => {
  it('POST /api/runtime/runs runs against the injected ctx.stepIntentStore', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-g59-'));
    try {
      const { fdb, tasks, evidence, audit, agents, agent, task } = makeWorld(join(dir, 'a.db'));
      try {
        const spy = new CountingStore();
        const calls: Array<{ status: number; body: unknown }> = [];
        const ctx = {
          tasks,
          evidence,
          audit,
          agents,
          engine: new WorkflowEngine({ tasks, evidence, audit }),
          fdb,
          stepIntentStore: spy,
          notify: { emit: () => {} },
          bus: { emit: () => {} },
          json: (_res: unknown, status: number, body: unknown) => {
            calls.push({ status, body });
          },
          readBody: async () => ({ agentId: agent.id, taskId: task.id }),
        } as unknown as RouteContext;

        const handled = await handleRuntimeRoutes(
          { method: 'POST' } as never,
          {} as never,
          new URL('http://localhost/api/runtime/runs'),
          ctx,
        );
        assert.equal(handled, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 202);
        const runId = (calls[0].body as { id: string }).id;
        assert.equal(await waitForRun(runId), 'COMPLETED');
        assert.ok(
          spy.listCalls >= 1,
          'runAgent consulted the injected store (intentSummary baseline) — the route forwarded ctx.stepIntentStore',
        );
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a gated-through tool call lands EXECUTED in SQLite via fdb.stepIntents and survives reopen', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-g59-'));
    const file = join(dir, 'b.db');
    try {
      const { fdb, agent, task } = makeWorld(file);
      const harness = new Harness({
        allowedRoots: [dir],
        stepTimeoutMs: 5000,
        permissions: agent.permissions,
        // The supported way to admit a tool (see header): echo requires
        // a capability the default agent actually holds.
        toolPermissions: { echo: 'filesystem.read' },
        evidence: { collect: () => {} },
        onAudit: () => {},
      });
      const result = await runAgent({
        agent,
        task,
        harness,
        // Exactly the object apps/server/src/index.ts puts in RouteContext.
        intentStore: fdb.stepIntents,
        adapter: new StubAdapter([
          { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hello' } }] },
        ]),
        loop: new AgentLoop({ budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 3 } }),
        tools: { echo: async (args) => ({ ok: true, echo: (args as { msg?: string }).msg ?? '' }) },
      });
      assert.equal(result.outcome, 'completed');
      assert.equal(result.intentSummary?.count, 1);
      assert.equal(result.intentSummary?.executed, 1);

      const intents = fdb.stepIntents.listIntents();
      assert.equal(intents.length, 1);
      assert.equal(intents[0].tool, 'echo');
      assert.equal(intents[0].status, 'EXECUTED');
      assert.equal(typeof intents[0].resultHash, 'string');
      assert.equal(fdb.stepIntents.listInterrupted().length, 0);
      fdb.close();

      // The whole point of G-59: a new process over the same file sees them.
      const fdb2 = new FactoryDatabase(file);
      try {
        assert.deepEqual(fdb2.stepIntents.listIntents(), intents);
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
