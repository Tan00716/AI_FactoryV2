/**
 * Batch 49 (F14) — per-request run budget overrides.
 *
 * What this pins (pure HTTP, zero mocks, against the real compiled server
 * over a fresh temp SQLite file, plus unit coverage of the resolver):
 *
 *  1. POSITIVE PATH — `POST /api/runtime/runs` with
 *     `budgets: { maxSteps: 3 }` drives a real run past its budget: the
 *     default stepFn would complete at the first EVALUATE (~6 phases),
 *     but the caller's tighter limit is genuinely enforced → the run
 *     terminates FAILED with machine reasonCode BUDGET_EXCEEDED → the
 *     §81 'budget-exceeded' upgrade record fires (exactly one OPEN
 *     record for the run, with the honest narrative in
 *     detailJson.narrative). This is the first deterministic HTTP
 *     trigger for 'budget-exceeded' (walkthrough finding F14); the
 *     emission machinery is unchanged (Batch-38 contract).
 *  2. MANIFEST HONESTY — the run's manifest snapshots the EFFECTIVE
 *     budgets (`budgetLimits.loop.maxSteps === 3`), not the server
 *     defaults — the Batch-15 no-drift invariant, now per-request.
 *  3. FAIL-CLOSED VALIDATION — malformed `budgets` (non-object, unknown
 *     key, zero/negative/fractional values) → 400 INVALID_BUDGETS and
 *     no run record is created.
 *  4. DEFAULTS UNCHANGED — a run with no `budgets` still COMPLETES under
 *     RUN_LOOP_BUDGETS (regression: the override is purely additive).
 *  5. RESUME PATH — `POST /api/runtime/runs/:id/resume` validates
 *     `budgets` the same way (400 on malformed input, before the 404).
 *
 * Requires the workspace build (root `npm run build`). Follows the
 * hermeticity rule (temp DB + temp FACTORY_SECRETS_DIR).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_LOOP_BUDGETS, resolveRunLoopBudgets } from '../src/routes/runtime.ts';

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-run-budgets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
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

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function waitForRun(port: number, runId: string, timeoutMs = 60_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    const rec = r.body as Json;
    if (rec['status'] !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

async function openUpgradesForRun(port: number, runId: string): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200);
  const items = (r.body['items'] ?? []) as Array<Json>;
  return items.filter((u) => String(u['source'] ?? '') === `runtime-run:${runId}`);
}

async function makeAgentAndTask(port: number): Promise<{ agentId: string; taskId: string }> {
  const agent = await api(port, 'POST', '/api/agents', { name: 'run-budgets-49', jobTitle: 'Engineer' });
  assert.equal(agent.status, 201);
  const project = await api(port, 'POST', '/api/projects', { name: 'run-budgets-49' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body['id'],
    title: 'run-budgets-49',
    goal: 'pin the per-request budget override',
  });
  assert.equal(task.status, 201);
  return { agentId: agent.body['id'] as string, taskId: task.body['id'] as string };
}

describe('resolveRunLoopBudgets (unit)', () => {
  it('absent budgets → server defaults', () => {
    const r = resolveRunLoopBudgets({});
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.budgets.maxSteps === RUN_LOOP_BUDGETS.maxSteps);
    assert.ok(r.ok && r.budgets.timeMs === RUN_LOOP_BUDGETS.timeMs);
    assert.ok(r.ok && r.budgets.maxRetries === RUN_LOOP_BUDGETS.maxRetries);
  });

  it('null budgets → server defaults', () => {
    const r = resolveRunLoopBudgets({ budgets: null });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.budgets.maxSteps === RUN_LOOP_BUDGETS.maxSteps);
  });

  it('partial override keeps the other defaults', () => {
    const r = resolveRunLoopBudgets({ budgets: { maxSteps: 3 } });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.budgets.maxSteps === 3);
    assert.ok(r.ok && r.budgets.timeMs === RUN_LOOP_BUDGETS.timeMs);
    assert.ok(r.ok && r.budgets.maxRetries === RUN_LOOP_BUDGETS.maxRetries);
  });

  it('full override', () => {
    const r = resolveRunLoopBudgets({ budgets: { maxSteps: 10, timeMs: 5000, maxRetries: 1 } });
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.budgets, { maxSteps: 10, timeMs: 5000, maxRetries: 1 });
  });

  it('non-object budgets rejected', () => {
    for (const bad of ['x', 42, [1]]) {
      const r = resolveRunLoopBudgets({ budgets: bad });
      assert.equal(r.ok, false);
      assert.ok(!r.ok && r.code === 'INVALID_BUDGETS');
    }
  });

  it('unknown key rejected (likely typo, never silently ignored)', () => {
    const r = resolveRunLoopBudgets({ budgets: { maxsteps: 3 } });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.code === 'INVALID_BUDGETS');
    assert.match(!r.ok ? r.error : '', /unknown budget key/);
  });

  it('non-positive-integer values rejected', () => {
    for (const bad of [0, -3, 1.5, '3', NaN]) {
      const r = resolveRunLoopBudgets({ budgets: { maxSteps: bad } });
      assert.equal(r.ok, false, `maxSteps=${String(bad)} should be rejected`);
      assert.ok(!r.ok && r.code === 'INVALID_BUDGETS');
    }
    const r2 = resolveRunLoopBudgets({ budgets: { timeMs: -1 } });
    assert.equal(r2.ok, false);
  });
});

describe("POST /api/runtime/runs budgets override (Batch 49, F14)", () => {
  it(
    'budgets { maxSteps: 3 } → run FAILED with BUDGET_EXCEEDED → exactly one budget-exceeded upgrade',
    { timeout: 120_000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-budgets-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        const run = await api(port, 'POST', '/api/runtime/runs', {
          agentId,
          taskId,
          budgets: { maxSteps: 3 },
        });
        assert.equal(run.status, 202);
        const runId = run.body['id'] as string;

        const finished = await waitForRun(port, runId);
        assert.equal(finished['status'], 'FAILED', `run failed on budget, got ${finished['status']}`);
        // The manifest snapshots the EFFECTIVE budgets, not the defaults.
        const manifest = await api(port, 'GET', `/api/runtime/runs/${runId}/manifest`);
        assert.equal(manifest.status, 200);
        const limits = (manifest.body['budgetLimits'] as Json)['loop'] as Json;
        assert.equal(limits['maxSteps'], 3, 'manifest reflects the per-request budget');

        const upgrades = await openUpgradesForRun(port, runId);
        assert.equal(upgrades.length, 1, `exactly one upgrade record, got ${upgrades.length}`);
        const [only] = upgrades;
        assert.equal(only['reason'], 'budget-exceeded');
        const detail = JSON.parse(String(only['detailJson'] ?? '{}')) as Json;
        assert.match(
          String(detail['narrative'] ?? ''),
          /resource fact/,
          'the honest qualifier survives in the persisted record',
        );
        t.diagnostic(`budgets {maxSteps:3} → FAILED + 1× budget-exceeded (run ${runId.slice(0, 8)}…)`);
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'malformed budgets → 400 INVALID_BUDGETS and no run record is created',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-budgets-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        for (const budgets of [
          { maxSteps: 0 },
          { maxSteps: -1 },
          { maxSteps: 2.5 },
          { maxsteps: 3 },
          'tight',
        ]) {
          const r = await api(port, 'POST', '/api/runtime/runs', {
            agentId,
            taskId,
            budgets: budgets as never,
          });
          assert.equal(r.status, 400, `budgets=${JSON.stringify(budgets)} → 400`);
          assert.equal(r.body['code'], 'INVALID_BUDGETS');
        }
        // No run records were created by the rejected requests.
        const runs = await api(port, 'GET', '/api/runtime/runs');
        assert.equal(runs.status, 200);
        assert.deepEqual(runs.body['runs'] ?? runs.body, [], 'no run records from rejected requests');
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'no budgets → run COMPLETES under defaults (override is purely additive)',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-budgets-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        const run = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId });
        assert.equal(run.status, 202);
        const finished = await waitForRun(port, run.body['id'] as string);
        assert.equal(finished['status'], 'COMPLETED', 'default behavior unchanged');

        const manifest = await api(port, 'GET', `/api/runtime/runs/${run.body['id']}/manifest`);
        assert.equal(manifest.status, 200);
        const limits = (manifest.body['budgetLimits'] as Json)['loop'] as Json;
        assert.equal(limits['maxSteps'], RUN_LOOP_BUDGETS.maxSteps);

        const upgrades = await openUpgradesForRun(port, run.body['id'] as string);
        assert.equal(upgrades.length, 0, 'no spurious budget-exceeded on a normal run');
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'resume path validates budgets the same way (400 before 404)',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-run-budgets-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const r = await api(port, 'POST', '/api/runtime/runs/does-not-exist/resume', {
          budgets: { maxSteps: 0 },
        });
        assert.equal(r.status, 400);
        assert.equal(r.body['code'], 'INVALID_BUDGETS');
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
