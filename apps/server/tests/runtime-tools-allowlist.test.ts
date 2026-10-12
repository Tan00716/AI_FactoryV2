/**
 * Runtime route tool allowlist — SPEC §26 fail-closed grants (Batch 10-2).
 *
 * What this pins:
 *  1. Default (FACTORY_RUNTIME_TOOLS unset): the route's tools stay
 *     denied — per §28.1 (Batch 12) the intent is persisted BEFORE the
 *     permission gate, so a denied call leaves a DENIED intent (the
 *     tool never executes), the denial is audited, and the run's
 *     RUNTIME_RUN_STARTED audit record shows an empty grantedTools
 *     list. The allowlist changes nothing until it is set.
 *  2. Allowlist set: the named tools really execute through the HTTP
 *     route — tool_result evidence lands on the run record (visible via
 *     GET /api/runtime/runs/:id) and their step intents land in SQLite
 *     as EXECUTED via ctx.stepIntentStore, surviving a DB reopen.
 *  3. The grant is scoped: a registered tool NOT in the allowlist is
 *     still denied, and the grant does not depend on the agent's own
 *     permissions (an agent registered with no permissions at all can
 *     run an allowlisted tool — the operator allowlist is the grant).
 *  4. An allowlist entry naming an unregistered tool is a config
 *     error: the request is refused (500, naming the bad entry), the
 *     error is audited, and no run is started.
 *
 * The route resolves the allowlist from the environment per request,
 * so each test sets/restores FACTORY_RUNTIME_TOOLS around itself.
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
import { FactoryDatabase } from '@ai-factory/db';
import {
  RUNTIME_TOOLS_ENV,
  getRuntimeRun,
  handleRuntimeRoutes,
  resolveRuntimeToolAllowlist,
  runtimeToolsStartupError,
  unknownRuntimeTools,
} from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { RuntimeRunRecord } from '../src/routes/runtime.ts';

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

/** Set (or clear) the allowlist env for the duration of fn; always restores. */
async function withAllowlistEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[RUNTIME_TOOLS_ENV];
  if (value === undefined) delete process.env[RUNTIME_TOOLS_ENV];
  else process.env[RUNTIME_TOOLS_ENV] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[RUNTIME_TOOLS_ENV];
    else process.env[RUNTIME_TOOLS_ENV] = prev;
  }
}

async function postRun(
  world: ReturnType<typeof makeWorld>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ctx, calls } = makeCtx(world, body);
  const handled = await handleRuntimeRoutes(
    { method: 'POST' } as never,
    {} as never,
    new URL('http://localhost/api/runtime/runs'),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return { status: calls[0].status, body: calls[0].body as Record<string, unknown> };
}

async function getRun(
  world: ReturnType<typeof makeWorld>,
  id: string,
): Promise<{ status: number; body: RuntimeRunRecord }> {
  const { ctx, calls } = makeCtx(world, {});
  const handled = await handleRuntimeRoutes(
    { method: 'GET' } as never,
    {} as never,
    new URL(`http://localhost/api/runtime/runs/${id}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return { status: calls[0].status, body: calls[0].body as RuntimeRunRecord };
}

async function waitForRun(id: string, timeoutMs = 10_000): Promise<RuntimeRunRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = getRuntimeRun(id);
    if (rec && rec.status !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${id} did not finish in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function toolEvidence(rec: RuntimeRunRecord, tool: string): Array<Record<string, unknown>> {
  return (rec.evidence as Array<Record<string, unknown>>).filter(
    (e) =>
      e['type'] === 'tool_result' &&
      (e['payload'] as Record<string, unknown>)?.['tool'] === tool,
  );
}

describe('allowlist parsing', () => {
  it('unset/empty/blank env means no tools granted', () => {
    assert.deepEqual(resolveRuntimeToolAllowlist({}), []);
    assert.deepEqual(resolveRuntimeToolAllowlist({ [RUNTIME_TOOLS_ENV]: '' }), []);
    assert.deepEqual(resolveRuntimeToolAllowlist({ [RUNTIME_TOOLS_ENV]: '  , ' }), []);
  });

  it('parses comma-separated names, trims and dedupes', () => {
    assert.deepEqual(
      resolveRuntimeToolAllowlist({ [RUNTIME_TOOLS_ENV]: ' echo,add , echo ' }),
      ['echo', 'add'],
    );
  });

  it('flags unregistered names and produces the startup error for them', () => {
    assert.deepEqual(unknownRuntimeTools(['echo', 'frobnicate']), ['frobnicate']);
    assert.deepEqual(unknownRuntimeTools(['echo', 'add']), []);
    assert.equal(runtimeToolsStartupError({ [RUNTIME_TOOLS_ENV]: 'echo' }), null);
    const err = runtimeToolsStartupError({ [RUNTIME_TOOLS_ENV]: 'echo,frobnicate' });
    assert.ok(err !== null && err.includes('frobnicate'));
  });
});

describe('runtime tool allowlist (FACTORY_RUNTIME_TOOLS)', () => {
  it('default (env unset): denied tool leaves a DENIED intent, grant audited as empty', { timeout: 20_000 }, async () => {
    await withAllowlistEnv(undefined, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-server-tools-'));
      try {
        const world = makeWorld(join(dir, 'a.db'));
        try {
          // The tool call must sit in the script's first adapter output:
          // the loop completes a run whose first output has no tool
          // calls, so the route's DEFAULT_SCRIPT (echo in entry 2)
          // never reaches the gate at all.
          const script = [
            { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hello' } }] },
            { text: 'verifying', toolCalls: [] },
          ];
          const { status, body } = await postRun(world, {
            agentId: world.agent.id,
            taskId: world.task.id,
            script,
          });
          assert.equal(status, 202);
          const runId = body['id'] as string;
          const rec = await waitForRun(runId);
          // §28.1 (Batch 12): the intent persisted before the gate, the
          // gate denied it — one DENIED intent, no tool evidence.
          const deniedIntents = world.fdb.stepIntents.listIntents();
          assert.equal(deniedIntents.length, 1);
          assert.equal(deniedIntents[0].tool, 'echo');
          assert.equal(deniedIntents[0].status, 'DENIED');
          assert.equal(toolEvidence(rec, 'echo').length, 0);
          // The denial is audited through the harness hook…
          const denials = world.audit
            .list()
            .filter((r) => r.action === 'RUNTIME_PERMISSION_DENIED');
          assert.ok(
            denials.some((r) => String(r.details['detail'] ?? '').includes('echo')),
            'expected an audited permission denial naming echo',
          );
          // …and the run-start audit shows the (empty) grant.
          const started = world.audit
            .list()
            .filter((r) => r.action === 'RUNTIME_RUN_STARTED');
          assert.equal(started.length, 1);
          assert.equal(started[0].entityId, runId);
          assert.deepEqual(started[0].details['grantedTools'], []);
          assert.equal(started[0].details['runId'], runId);
          assert.equal(started[0].details['actor'], world.agent.id);
        } finally {
          world.fdb.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('allowlisted echo+add execute: tool evidence on the run, EXECUTED intents in SQLite', { timeout: 20_000 }, async () => {
    await withAllowlistEnv('echo,add', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-server-tools-'));
      const file = join(dir, 'b.db');
      try {
        const world = makeWorld(file);
        const script = [
          {
            text: 'acting',
            toolCalls: [
              { tool: 'echo', args: { msg: 'hello' } },
              { tool: 'add', args: { a: 2, b: 3 } },
            ],
          },
          { text: 'verifying', toolCalls: [] },
        ];
        const { status, body } = await postRun(world, {
          agentId: world.agent.id,
          taskId: world.task.id,
          script,
        });
        assert.equal(status, 202);
        const runId = body['id'] as string;
        const rec = await waitForRun(runId);
        assert.equal(rec.status, 'COMPLETED');

        // The run record (and the GET response built from it) carries the
        // tool results as tool_result evidence.
        for (const tool of ['echo', 'add']) {
          const ev = toolEvidence(rec, tool);
          assert.equal(ev.length, 1, `expected one tool_result evidence for ${tool}`);
          assert.equal((ev[0]['payload'] as Record<string, unknown>)['ok'], true);
        }
        const got = await getRun(world, runId);
        assert.equal(got.status, 200);
        assert.equal(toolEvidence(got.body, 'echo').length, 1);
        assert.equal(toolEvidence(got.body, 'add').length, 1);

        // Both intents are committed in SQLite…
        const intents = world.fdb.stepIntents.listIntents();
        assert.equal(intents.length, 2);
        assert.deepEqual(
          intents.map((i) => i.tool).sort(),
          ['add', 'echo'],
        );
        for (const intent of intents) {
          assert.equal(intent.status, 'EXECUTED');
          assert.equal(typeof intent.resultHash, 'string');
        }
        assert.equal(world.fdb.stepIntents.listInterrupted().length, 0);

        // …and the grant itself is audited.
        const started = world.audit
          .list()
          .filter((r) => r.action === 'RUNTIME_RUN_STARTED');
        assert.equal(started.length, 1);
        assert.deepEqual(started[0].details['grantedTools'], ['echo', 'add']);
        world.fdb.close();

        // Durability: a new process over the same file sees the intents.
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

  it('only the allowlisted tool is granted: add stays denied when only echo is listed', { timeout: 20_000 }, async () => {
    await withAllowlistEnv('echo', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-server-tools-'));
      try {
        const world = makeWorld(join(dir, 'c.db'));
        try {
          const script = [
            {
              text: 'acting',
              toolCalls: [
                { tool: 'echo', args: { msg: 'hello' } },
                { tool: 'add', args: { a: 1, b: 1 } },
              ],
            },
            { text: 'verifying', toolCalls: [] },
          ];
          const { status, body } = await postRun(world, {
            agentId: world.agent.id,
            taskId: world.task.id,
            script,
          });
          assert.equal(status, 202);
          const rec = await waitForRun(body['id'] as string);
          // echo executed and committed; add's intent persisted (§28.1)
          // and was then denied — DENIED, never executed.
          const intents = world.fdb.stepIntents.listIntents();
          assert.equal(intents.length, 2);
          const byTool = new Map(intents.map((i) => [i.tool, i]));
          assert.equal(byTool.get('echo')?.status, 'EXECUTED');
          assert.equal(byTool.get('add')?.status, 'DENIED');
          assert.equal(toolEvidence(rec, 'echo').length, 1);
          assert.equal(toolEvidence(rec, 'add').length, 0);
          const denials = world.audit
            .list()
            .filter((r) => r.action === 'RUNTIME_PERMISSION_DENIED');
          assert.ok(
            denials.some((r) => String(r.details['detail'] ?? '').includes('add')),
            'expected an audited permission denial naming add',
          );
          const started = world.audit
            .list()
            .filter((r) => r.action === 'RUNTIME_RUN_STARTED');
          assert.deepEqual(started[0].details['grantedTools'], ['echo']);
        } finally {
          world.fdb.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('the allowlist grant stands alone: an agent with no permissions can run a granted tool', { timeout: 20_000 }, async () => {
    await withAllowlistEnv('echo', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-server-tools-'));
      try {
        const world = makeWorld(join(dir, 'd.db'));
        try {
          const bare = world.agents.register({
            name: 'bare',
            jobTitle: 'Engineer',
            permissions: [],
          });
          assert.deepEqual(bare.permissions, []);
          const script = [
            { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hi' } }] },
            { text: 'verifying', toolCalls: [] },
          ];
          const { status, body } = await postRun(world, {
            agentId: bare.id,
            taskId: world.task.id,
            script,
          });
          assert.equal(status, 202);
          const rec = await waitForRun(body['id'] as string);
          assert.equal(rec.status, 'COMPLETED');
          assert.equal(toolEvidence(rec, 'echo').length, 1);
          const intents = world.fdb.stepIntents.listIntents();
          assert.equal(intents.length, 1);
          assert.equal(intents[0].status, 'EXECUTED');
          // The agent's own stored permissions were not mutated by the grant.
          assert.deepEqual(world.agents.get(bare.id).permissions, []);
        } finally {
          world.fdb.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('an unregistered allowlist name refuses the run with an audited 500', { timeout: 20_000 }, async () => {
    await withAllowlistEnv('echo,frobnicate', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-server-tools-'));
      try {
        const world = makeWorld(join(dir, 'e.db'));
        try {
          const { status, body } = await postRun(world, {
            agentId: world.agent.id,
            taskId: world.task.id,
          });
          assert.equal(status, 500);
          assert.ok(String(body['error']).includes('frobnicate'));
          assert.equal(body['id'], undefined, 'no run was started');
          const errors = world.audit
            .list()
            .filter((r) => r.action === 'RUNTIME_TOOLS_CONFIG_ERROR');
          assert.equal(errors.length, 1);
          assert.deepEqual(errors[0].details['unknownTools'], ['frobnicate']);
          assert.equal(
            world.audit.list().filter((r) => r.action === 'RUNTIME_RUN_STARTED').length,
            0,
          );
          assert.equal(world.fdb.stepIntents.listIntents().length, 0);
        } finally {
          world.fdb.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
