/**
 * Batch 44 — §81 'irrecoverable-env-error': the HTTP-reachable boundary.
 * Batch 75 (F28) — the S8 flip point: Tan's decision "A A A" (2026-10-15)
 * added an operator-gated, explicitly declared env-error signal, so the
 * boundary below now reads "without the signal".
 *
 * What this pins (pure HTTP, zero mocks, against the real compiled server
 * over a fresh temp SQLite file):
 *
 *  1. NEGATIVE CONTROL (no signal) — a non-env stagnation over HTTP emits
 *     exactly one 'repeated-failure' upgrade and ZERO
 *     'irrecoverable-env-error' upgrades. The env gate does not
 *     false-positive: an unknown tool requested 3× in a row →
 *     LoopStagnation('adapter:unknown-tool') → run ESCALATED → the
 *     Batch-38 'repeated-failure' record fires (reasonCode
 *     LOOP_STAGNATION, machine code not message) and the Batch-43 env
 *     block stays silent.
 *
 *  2. POSITIVE PATH (Batch 75) — `POST /api/runtime/runs` with
 *     `envErrorSignal: 'ENV_SANDBOX_UNAVAILABLE'` (an ENV_ERROR_CODES
 *     member) makes the run's step function throw the declared env
 *     FactoryError on every step → LoopStagnation(ENV_SANDBOX_UNAVAILABLE)
 *     → run ESCALATED → the Batch-38 'repeated-failure' record fires
 *     AND the Batch-43 env block fires exactly one
 *     'irrecoverable-env-error' record, qualified as
 *     declared-not-observed (the failure was injected by declaration,
 *     not probed on the host). This is the S8 flip point Tan approved:
 *     the footgun is real and the protections are explicit —
 *     operator-gated endpoint (viewer → 403, unauthenticated → 401),
 *     fail-closed 400 INVALID_ENV_ERROR_SIGNAL, audited
 *     RUNTIME_ENV_ERROR_SIGNAL_USED, the signal stamped on the run
 *     manifest's driver.
 *
 *  3. BOUNDARY TRIPWIRE — with no signal, the HTTP surface still cannot
 *     produce an ENV_* stagnation signature on its own: RUNTIME_TOOL_NAMES
 *     is exactly the pure set {echo, add} (no registered tool can throw a
 *     FactoryError with an ENV_* code). This is asserted as code, not
 *     prose. The full chain, verified by reading the code:
 *       (a) POST /api/runtime/runs and POST /api/runtime/runs/:id/resume
 *           both build `new StubAdapter(script)` and never pass a custom
 *           stepFn — runAgent always uses its internal default stepFn,
 *           unless the creation POST carries the explicit, validated
 *           `envErrorSignal` (the resume route never accepts it);
 *       (b) the default stepFn catches tool-impl errors and masks the
 *           FactoryError code as `tool:<name>:fail` (only BudgetExceeded
 *           and PERMISSION_BYPASS_ATTEMPT are rethrown, both terminal,
 *           never stagnation);
 *       (c) assertSandboxAvailable has zero production callers;
 *       (d) the adapter is always the StubAdapter (routeRequest only
 *           selects model names, never the adapter), which never throws.
 *     Consequence: without the signal, the ONLY way to reach the
 *     emission block is an embedder-injected stepFn that throws a
 *     FactoryError with an ENV_* code (the package-level true path,
 *     pinned in packages/runtime/tests/env-error-codes.test.ts). If the
 *     registered tool set ever gains a throwing tool, this test fails
 *     loudly and the author must re-examine whether an env stagnation
 *     signature — and hence the emission — becomes HTTP-reachable
 *     without the signal.
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
import {
  makeEnvErrorSignalStepFn,
  resolveEnvErrorSignal,
  RUNTIME_TOOL_NAMES,
} from '../src/routes/runtime.ts';

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

async function bootServer(dbFile: string, extraEnv: Record<string, string> = {}): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault — server tests must not inherit the
    // developer's local vault (fail-closed on stale entries).
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-env-http-${port}`),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
  // Auth-mode tests pass FACTORY_API_TOKENS through extraEnv; the
  // legacy single token must not sneak in from the dev environment.
  if (!('FACTORY_API_TOKENS' in extraEnv)) delete env['FACTORY_API_TOKENS'];
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

  it('resolveEnvErrorSignal: absent → null; member → ok; anything else → 400 INVALID_ENV_ERROR_SIGNAL', async () => {
    assert.deepEqual(resolveEnvErrorSignal({}), { ok: true, signal: null });
    assert.deepEqual(resolveEnvErrorSignal({ envErrorSignal: null }), { ok: true, signal: null });
    assert.deepEqual(resolveEnvErrorSignal({ envErrorSignal: 'ENV_SANDBOX_UNAVAILABLE' }), {
      ok: true,
      signal: 'ENV_SANDBOX_UNAVAILABLE',
    });
    assert.deepEqual(resolveEnvErrorSignal({ envErrorSignal: 'ENV_BINARY_MISSING' }), {
      ok: true,
      signal: 'ENV_BINARY_MISSING',
    });
    for (const bad of ['NOPE', '', 'env_sandbox_unavailable', 5, true, {}, []]) {
      const r = resolveEnvErrorSignal({ envErrorSignal: bad });
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
      assert.equal((r as { code: string }).code, 'INVALID_ENV_ERROR_SIGNAL');
    }
  });

  it('makeEnvErrorSignalStepFn: throws the declared env FactoryError (machine code, not message)', async () => {
    for (const [code, stepFn] of [
      ['ENV_SANDBOX_UNAVAILABLE', makeEnvErrorSignalStepFn('ENV_SANDBOX_UNAVAILABLE')],
      ['ENV_BINARY_MISSING', makeEnvErrorSignalStepFn('ENV_BINARY_MISSING')],
    ] as const) {
      let thrown: unknown;
      try {
        await stepFn('ACT' as never, {} as never);
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, `stepFn for ${code} throws`);
      assert.equal((thrown as { code?: string }).code, code, 'machine-readable env code');
      assert.match((thrown as Error).message, /declared via the HTTP env-error signal/);
    }
  });

  it(
    'positive (Batch 75): operator-declared envErrorSignal → ESCALATED with repeated-failure + irrecoverable-env-error, declared-not-observed',
    { timeout: 120_000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-env-http-pos-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        const run = await api(port, 'POST', '/api/runtime/runs', {
          agentId,
          taskId,
          envErrorSignal: 'ENV_SANDBOX_UNAVAILABLE',
        });
        assert.equal(run.status, 202);
        const runId = run.body['id'] as string;

        const finished = await waitForRun(port, runId);
        assert.equal(finished['status'], 'ESCALATED', `run escalated, got ${finished['status']}`);

        // The S8 flip point: the Batch-38 'repeated-failure' record fires
        // AND the Batch-43 env block fires exactly one
        // 'irrecoverable-env-error' record.
        const upgrades = await openUpgradesForRun(port, runId);
        assert.equal(upgrades.length, 2, `exactly two upgrade records, got ${upgrades.length}`);
        const reasons = upgrades.map((u) => u['reason']).sort();
        assert.deepEqual(reasons, ['irrecoverable-env-error', 'repeated-failure']);
        const envRec = upgrades.find((u) => u['reason'] === 'irrecoverable-env-error')!;
        const ctx = JSON.parse(String(envRec['contextJson'] ?? '{}')) as Json;
        assert.equal(ctx['envErrorCode'], 'ENV_SANDBOX_UNAVAILABLE');
        assert.equal(ctx['envErrorSignal'], 'ENV_SANDBOX_UNAVAILABLE');
        const detail = JSON.parse(String(envRec['detailJson'] ?? '{}')) as Json;
        assert.equal(detail['envErrorSignal'], 'ENV_SANDBOX_UNAVAILABLE');
        // Declared-not-observed: the narrative must never read like a
        // measured host fact.
        assert.match(
          String(detail['narrative']),
          /DECLARED environment error/,
          'narrative names the declaration',
        );
        assert.match(
          String(detail['narrative']),
          /NOT observed by probing a real host/,
          'narrative denies host observation',
        );

        // Every signal use is audited.
        const auditRes = await fetch(`http://127.0.0.1:${port}/api/audit?limit=500`);
        assert.equal(auditRes.status, 200);
        const auditRows = (await auditRes.json()) as Array<Json>;
        const signalUse = auditRows.find(
          (r) => r['action'] === 'RUNTIME_ENV_ERROR_SIGNAL_USED' && r['entityId'] === runId,
        );
        assert.ok(signalUse, 'RUNTIME_ENV_ERROR_SIGNAL_USED is audited for the run');
        assert.equal(
          (signalUse['details'] as Json)['envErrorCode'],
          'ENV_SANDBOX_UNAVAILABLE',
          'the audit record carries the declared code',
        );
        // The run manifest's driver stamps the signal.
        const mRes = await fetch(`http://127.0.0.1:${port}/api/runtime/runs/${runId}/manifest`);
        assert.equal(mRes.status, 200, 'manifest is readable');
        const manifest = (await mRes.json()) as Json;
        assert.equal(
          ((manifest['driver'] ?? {}) as Json)['envErrorSignal'],
          'ENV_SANDBOX_UNAVAILABLE',
          'manifest driver records the declared signal',
        );

        t.diagnostic(
          `envErrorSignal → ESCALATED, 1× repeated-failure + 1× irrecoverable-env-error (run ${runId.slice(0, 8)}…)`,
        );
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'invalid envErrorSignal → 400 INVALID_ENV_ERROR_SIGNAL, fail-closed (no run record)',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-env-http-bad-'));
      let server: BootedServer | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;
        const { agentId, taskId } = await makeAgentAndTask(port);

        for (const bad of ['NOT_A_CODE', 42, { code: 'ENV_SANDBOX_UNAVAILABLE' }]) {
          const r = await api(port, 'POST', '/api/runtime/runs', {
            agentId,
            taskId,
            envErrorSignal: bad,
          });
          assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
          assert.equal(r.body['code'], 'INVALID_ENV_ERROR_SIGNAL');
        }
        // Fail-closed: the refused requests left no run records behind.
        const runs = await api(port, 'GET', '/api/runtime/runs');
        assert.equal(runs.status, 200);
        assert.deepEqual(runs.body['runs'], []);
      } finally {
        if (server) await stopServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'auth contract (Batch 75): the signal-carrying POST is operator-gated — viewer → 403, unauthenticated → 401, operator → 202',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-env-http-auth-'));
      let server: BootedServer | undefined;
      const VIEWER = 'viewer-secret-f28';
      const OPERATOR = 'operator-secret-f28';
      try {
        server = await bootServer(join(dir, 'factory.db'), {
          FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR}`,
        });
        const port = server.port;
        const authed = (token: string | undefined, method: string, path: string, body?: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          });

        // Writes need operator: set up agent + task with the operator token.
        const agentRes = await authed(OPERATOR, 'POST', '/api/agents', {
          name: 'env-http-auth-75',
          jobTitle: 'Engineer',
        });
        assert.equal(agentRes.status, 201);
        const agentId = ((await agentRes.json()) as Json)['id'] as string;
        const projectRes = await authed(OPERATOR, 'POST', '/api/projects', { name: 'env-http-auth-75' });
        assert.equal(projectRes.status, 201);
        const taskRes = await authed(OPERATOR, 'POST', '/api/tasks', {
          projectId: ((await projectRes.json()) as Json)['id'],
          title: 'env-http-auth-75',
          goal: 'pin the env-error signal auth contract',
        });
        assert.equal(taskRes.status, 201);
        const taskId = ((await taskRes.json()) as Json)['id'] as string;

        const signalBody = { agentId, taskId, envErrorSignal: 'ENV_BINARY_MISSING' };
        // Unauthenticated → 401.
        const anon = await authed(undefined, 'POST', '/api/runtime/runs', signalBody);
        assert.equal(anon.status, 401);
        // Viewer → 403 (the protection for this declared footgun).
        const viewer = await authed(VIEWER, 'POST', '/api/runtime/runs', signalBody);
        assert.equal(viewer.status, 403);
        // Operator → 202 (accepted; the run itself is covered by the
        // positive test above).
        const operator = await authed(OPERATOR, 'POST', '/api/runtime/runs', signalBody);
        assert.equal(operator.status, 202);
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
