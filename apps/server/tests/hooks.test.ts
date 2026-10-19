/**
 * Hooks tests (W-B) — deterministic lifecycle hooks.
 *
 * Unit level (imports ../src/hooks.ts directly — node builtins only):
 *   PreToolUse: {"decision":"deny"} verdict → veto; non-zero exit → veto;
 *     timeout → veto (fail-closed); {"decision":"allow"} → allowed;
 *     no verdict + exit 0 → allowed; tool matcher filters.
 *   PostToolUse: hook failure never vetoes.
 *   Registry: createHook validation, deleteHook.
 *
 * HTTP level (real server, isolated DB + data dir):
 *   POST /api/hooks (PreToolUse deny-all for tool=exec) →
 *   POST /api/exec → 403 HOOK_VETO, command NOT executed →
 *   DELETE /api/hooks/:id → POST /api/exec works again.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/hooks.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHook,
  deleteHook,
  evaluateHooks,
  loadHooks,
  runHook,
} from '../src/hooks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

function withTempHooksFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-hooks-unit-'));
  const file = path.join(dir, 'hooks.json');
  process.env.AI_FACTORY_HOOKS_FILE = file;
  return dir;
}

function clearTempHooksFile(dir: string): void {
  delete process.env.AI_FACTORY_HOOKS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
}

function mkHook(over: Record<string, unknown> = {}) {
  return {
    id: 'hook-test-1',
    event: 'PreToolUse' as const,
    command: `echo '{"decision":"allow"}'`,
    timeoutMs: 5000,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('runHook verdict parsing', () => {
  it('parses deny/allow JSON verdicts from stdout', async () => {
    const deny = await runHook(
      mkHook({ command: `echo '{"decision":"deny","reason":"nope"}'` }),
      { event: 'PreToolUse', tool: 'exec' },
    );
    assert.equal(deny.verdict, 'deny');
    assert.equal(deny.reason, 'nope');

    const allow = await runHook(mkHook(), { event: 'PreToolUse', tool: 'exec' });
    assert.equal(allow.verdict, 'allow');
  });

  it('non-zero exit without verdict counts as deny', async () => {
    const r = await runHook(mkHook({ command: 'exit 3' }), { event: 'PreToolUse', tool: 'exec' });
    assert.equal(r.verdict, 'deny');
    assert.equal(r.ok, false);
  });

  it('no verdict + exit 0 counts as allow', async () => {
    const r = await runHook(mkHook({ command: 'echo hello' }), { event: 'PreToolUse', tool: 'exec' });
    assert.equal(r.verdict, null);
    assert.equal(r.ok, true);
  });

  it('timeout is reported', async () => {
    const r = await runHook(mkHook({ command: 'sleep 5', timeoutMs: 300 }), {
      event: 'PreToolUse',
      tool: 'exec',
    });
    assert.equal(r.timedOut, true);
  });

  it('payload arrives as JSON on stdin', async () => {
    const r = await runHook(
      mkHook({ command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({decision:p.tool==='exec'?'allow':'deny'}))})"` }),
      { event: 'PreToolUse', tool: 'exec' },
    );
    assert.equal(r.verdict, 'allow');
  });
});

describe('evaluateHooks veto semantics', () => {
  it('PreToolUse: deny verdict vetoes (fail-closed)', async () => {
    const hooks = [
      mkHook({ id: 'h1', command: `echo '{"decision":"deny","reason":"blocked by policy"}'` }),
    ];
    const ev = await evaluateHooks('PreToolUse', { tool: 'exec' }, hooks);
    assert.equal(ev.allowed, false);
    assert.equal(ev.veto?.hookId, 'h1');
    assert.equal(ev.veto?.reason, 'blocked by policy');
  });

  it('PreToolUse: timeout vetoes (fail-closed)', async () => {
    const hooks = [mkHook({ id: 'h1', command: 'sleep 5', timeoutMs: 300 })];
    const ev = await evaluateHooks('PreToolUse', { tool: 'exec' }, hooks);
    assert.equal(ev.allowed, false);
    assert.ok(ev.veto?.reason.includes('timed out'));
  });

  it('PreToolUse: allow passes; tool matcher filters', async () => {
    const hooks = [
      mkHook({ id: 'h1', tool: 'write' }), // different tool → skipped
      mkHook({ id: 'h2' }),
    ];
    const ev = await evaluateHooks('PreToolUse', { tool: 'exec' }, hooks);
    assert.equal(ev.allowed, true);
    assert.deepEqual(ev.runs.map((r) => r.hookId), ['h2']);
  });

  it('PostToolUse: failures never veto', async () => {
    const hooks = [
      mkHook({ id: 'h1', event: 'PostToolUse', command: 'exit 7' }),
      mkHook({ id: 'h2', event: 'PostToolUse', command: 'sleep 5', timeoutMs: 300 }),
    ];
    const ev = await evaluateHooks('PostToolUse', { tool: 'exec' }, hooks);
    assert.equal(ev.allowed, true);
    assert.equal(ev.runs.length, 2);
  });

  it('disabled hooks are skipped', async () => {
    const hooks = [
      mkHook({ id: 'h1', enabled: false, command: `echo '{"decision":"deny"}'` }),
    ];
    const ev = await evaluateHooks('PreToolUse', { tool: 'exec' }, hooks);
    assert.equal(ev.allowed, true);
    assert.equal(ev.runs.length, 0);
  });
});

describe('hook registry', () => {
  it('createHook validates; deleteHook removes', () => {
    const dir = withTempHooksFile();
    try {
      assert.deepEqual(loadHooks(), []);
      const h = createHook({ event: 'PreToolUse', command: 'echo hi', description: 'd' });
      assert.ok(h.id);
      assert.equal(loadHooks().length, 1);

      assert.throws(() => createHook({ event: 'Bogus', command: 'echo hi' }), /event must be/);
      assert.throws(() => createHook({ event: 'PreToolUse', command: '' }), /command is required/);
      assert.throws(
        () => createHook({ event: 'PreToolUse', command: 'echo hi', timeoutMs: 999_999_999 }),
        /timeoutMs/,
      );

      assert.equal(deleteHook(h.id), true);
      assert.equal(deleteHook(h.id), false);
      assert.deepEqual(loadHooks(), []);
    } finally {
      clearTempHooksFile(dir);
    }
  });
});

// ── HTTP level: PreToolUse veto on POST /api/exec ──

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-hooks-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    // This suite tests hook veto semantics, not OS sandboxing: run
    // with the sandbox explicitly disabled so /api/exec works on
    // machines without bwrap (fail-closed would 403 everything).
    FACTORY_EXEC_SANDBOX: '0',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('PreToolUse veto over HTTP', () => {
  it('a deny hook vetoes POST /api/exec with 403 and the command never runs', async () => {
    const s = await startServer();
    try {
      // Baseline: exec works.
      const base = await api(s.port, 'POST', '/api/exec', { command: 'echo baseline-ok' });
      assert.equal(base.status, 200);
      assert.ok((base.body.output as string).includes('baseline-ok'));

      // Register a deny-all PreToolUse hook for tool=exec.
      const created = await api(s.port, 'POST', '/api/hooks', {
        event: 'PreToolUse',
        tool: 'exec',
        command: `echo '{"decision":"deny","reason":"test veto"}'`,
        description: 'test veto hook',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const hookId = created.body.hook.id as string;

      const listed = await api(s.port, 'GET', '/api/hooks');
      assert.equal(listed.status, 200);
      assert.ok((listed.body.hooks as { id: string }[]).some((h) => h.id === hookId));

      // The exec call is vetoed — 403, command never executed.
      const vetoed = await api(s.port, 'POST', '/api/exec', { command: 'echo should-not-run' });
      assert.equal(vetoed.status, 403, JSON.stringify(vetoed.body));
      assert.equal(vetoed.body.code, 'HOOK_VETO');
      assert.ok((vetoed.body.error as string).includes('test veto'));

      // Remove the hook → exec works again.
      const del = await api(s.port, 'DELETE', `/api/hooks/${hookId}`);
      assert.equal(del.status, 200);
      const after = await api(s.port, 'POST', '/api/exec', { command: 'echo restored-ok' });
      assert.equal(after.status, 200);
      assert.ok((after.body.output as string).includes('restored-ok'));
    } finally {
      await stopServer(s);
    }
  });

  it('hook test dry-run endpoint works', async () => {
    const s = await startServer();
    try {
      const created = await api(s.port, 'POST', '/api/hooks', {
        event: 'PostToolUse',
        command: `echo '{"decision":"allow"}'`,
      });
      assert.equal(created.status, 201);
      const hookId = created.body.hook.id as string;
      const t = await api(s.port, 'POST', `/api/hooks/${hookId}/test`, {});
      assert.equal(t.status, 200);
      assert.equal(t.body.run.verdict, 'allow');
      await api(s.port, 'DELETE', `/api/hooks/${hookId}`);
    } finally {
      await stopServer(s);
    }
  });
});
