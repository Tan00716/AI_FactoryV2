/**
 * Batch 44 — §81 'irrecoverable-env-error': the HTTP-reachable boundary.
 *
 * What this pins (pure HTTP, zero mocks, against the real compiled server
 * over a fresh temp SQLite file):
 *
 *  1. NEGATIVE CONTROL — a non-env stagnation over HTTP emits exactly one
 *     'repeated-failure' upgrade and ZERO 'irrecoverable-env-error'
 *     upgrades. The env gate does not false-positive: an unknown tool
 *     requested 3× in a row → LoopStagnation('adapter:unknown-tool') →
 *     run ESCALATED → the Batch-38 'repeated-failure' record fires
 *     (reasonCode LOOP_STAGNATION, machine code not message) and the
 *     Batch-43 env block stays silent.
 *
 *  2. BOUNDARY TRIPWIRE — the HTTP surface cannot produce an ENV_*
 *     stagnation signature today, so the Batch-43 emission block has no
 *     HTTP-reachable positive path. This is asserted as code, not prose:
 *     RUNTIME_TOOL_NAMES is exactly the pure set {echo, add} (no
 *     registered tool can throw a FactoryError with an ENV_* code). The
 *     full chain, verified by reading the code:
 *       (a) POST /api/runtime/runs and POST /api/runtime/runs/:id/resume
 *           both build `new StubAdapter(script)` and never pass a custom
 *           stepFn — runAgent always uses its internal default stepFn;
 *       (b) the default stepFn catches tool-impl errors and masks the
 *           FactoryError code as `tool:<name>:fail` (only BudgetExceeded
 *           and PERMISSION_BYPASS_ATTEMPT are rethrown, both terminal,
 *           never stagnation);
 *       (c) assertSandboxAvailable has zero production callers;
 *       (d) the adapter is always the StubAdapter (routeRequest only
 *           selects model names, never the adapter), which never throws.
 *     Consequence: the ONLY way to reach the emission block is an
 *     embedder-injected stepFn that throws a FactoryError with an ENV_*
 *     code (the package-level true path, pinned in
 *     packages/runtime/tests/env-error-codes.test.ts). If the registered
 *     tool set ever gains a throwing tool, this test fails loudly and the
 *     author must re-examine whether an env stagnation signature — and
 *     hence the emission — becomes HTTP-reachable.
 *
 * Requires the workspace build (root `npm run build`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_TOOL_NAMES } from '../src/routes/runtime.ts';

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
    // Hermetic secrets vault — server tests must not inherit the
    // developer's local vault (fail-closed on stale entries).
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-env-http-${port}`),
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
  const agent = await api(port, 'POST', '/api/agents', { name: 'env-http-44', jobTitle: 'Engineer' });
  assert.equal(agent.status, 201);
  const project = await api(port, 'POST', '/api/projects', { name: 'env-http-44' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body['id'],
    title: 'env-http-44',
    goal: 'pin the irrecoverable-env-error HTTP boundary',
  });
  assert.equal(task.status, 201);
  return { agentId: agent.body['id'] as string, taskId: task.body['id'] as string };
}

describe("§81 'irrecoverable-env-error' HTTP boundary (Batch 44)", () => {
  it(
    'non-env stagnation over HTTP → exactly one repeated-failure record, zero irrecoverable-env-error',
    { timeout: 120_000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-env-http-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        // The adapter keeps requesting a tool that does not exist: the
        // loop sees 'adapter:unknown-tool' 3× with no progress →
        // LoopStagnation → escalated. Deterministic, pure HTTP.
        const script = Array.from({ length: 4 }, (_, i) => ({
          text: `broken step ${i}`,
          toolCalls: [{ tool: 'no-such-tool-env-http-44', args: {} }],
        }));
        const run = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId, script });
        assert.equal(run.status, 202);
        const runId = run.body['id'] as string;

        const finished = await waitForRun(port, runId);
        assert.equal(finished['status'], 'ESCALATED', `run escalated, got ${finished['status']}`);

        const upgrades = await openUpgradesForRun(port, runId);
        assert.equal(upgrades.length, 1, `exactly one upgrade record, got ${upgrades.length}`);
        const [only] = upgrades;
        assert.equal(only['reason'], 'repeated-failure');
        const ctx = JSON.parse(String(only['contextJson'] ?? '{}')) as Json;
        assert.equal(ctx['reasonCode'], 'LOOP_STAGNATION', 'classified by machine code, not message');
        assert.ok(
          !upgrades.some((u) => u['reason'] === 'irrecoverable-env-error'),
          'the env gate stays silent on a non-env stagnation signature',
        );
        t.diagnostic(
          `non-env stagnation → 1× repeated-failure, 0× irrecoverable-env-error (run ${runId.slice(0, 8)}…)`,
        );
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('the registered runtime tool set cannot throw an ENV_* FactoryError (boundary tripwire)', async () => {
    // Pure in-process tools: no filesystem, shell, git or network
    // effects — see the RUNTIME_TOOLS header note in routes/runtime.ts.
    // If this set ever gains a tool that can throw MissingBinaryError /
    // SandboxUnavailableError (or any FactoryError with an ENV_* code),
    // the irrecoverable-env-error emission may become HTTP-reachable and
    // this tripwire forces that re-examination. See the file header for
    // the full chain of why no HTTP input can produce an ENV_*
    // stagnation signature today.
    assert.deepEqual(
      [...RUNTIME_TOOL_NAMES].sort(),
      ['add', 'echo'],
      'registered runtime tools changed — re-examine the env-error HTTP boundary',
    );
  });
});
