/**
 * Exec sandbox (bubblewrap) tests — bwrap wrapping for /api/exec,
 * terminal sessions and the tool-runner's shell.execute.
 *
 * Dual-mode note: imports the COMPILED ../dist/exec-sandbox.js (root
 * build must run first), because exec-sandbox.ts value-imports
 * ./build-sandbox, which value-imports @ai-factory/runtime — node
 * type-stripping cannot resolve that chain from src (AGENTS.md
 * dual-mode rule).
 *
 * These tests need a WORKING bwrap for the sandboxed paths. bwrap is
 * not installed in this environment, so sandbox-execution tests use a
 * fake bwrap (a shell script honoring FACTORY_BWRAP_BIN): it asserts
 * the sandbox argv shape and then exec's the real command WITHOUT
 * isolation — enough to prove the wiring (prefix applied, fallback
 * marked), never a claim of real isolation. The unavailable path is
 * tested via a bogus FACTORY_BWRAP_BIN.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execSandboxConfigFromEnv,
  buildExecSandboxPrefix,
  decideExecSandbox,
  resetExecSandboxProbeCacheForTests,
} from '../dist/exec-sandbox.js';

const BOGUS_BIN = '/nonexistent/bwrap-exec-sandbox-xyz';

describe('execSandboxConfigFromEnv', () => {
  it('defaults: enabled, workspace-write, network shared, bwrap on PATH', () => {
    const c = execSandboxConfigFromEnv({});
    assert.equal(c.enabled, true);
    assert.equal(c.mode, 'workspace-write');
    assert.equal(c.network, true);
    assert.equal(c.bwrapBin, 'bwrap');
    assert.deepEqual(c.extraRoBinds, ['/usr', '/opt']);
  });
  it('FACTORY_EXEC_SANDBOX=0 disables', () => {
    assert.equal(execSandboxConfigFromEnv({ FACTORY_EXEC_SANDBOX: '0' }).enabled, false);
    assert.equal(execSandboxConfigFromEnv({ FACTORY_EXEC_SANDBOX: 'off' }).enabled, false);
    assert.equal(execSandboxConfigFromEnv({ FACTORY_EXEC_SANDBOX: '1' }).enabled, true);
  });
  it('FACTORY_EXEC_SANDBOX_NETWORK=0 isolates the network', () => {
    assert.equal(execSandboxConfigFromEnv({ FACTORY_EXEC_SANDBOX_NETWORK: '0' }).network, false);
    assert.equal(execSandboxConfigFromEnv({ FACTORY_EXEC_SANDBOX_NETWORK: 'no' }).network, false);
    assert.equal(execSandboxConfigFromEnv({}).network, true);
  });
  it('FACTORY_BWRAP_BIN and FACTORY_EXEC_SANDBOX_RO_BINDS overrides', () => {
    const c = execSandboxConfigFromEnv({
      FACTORY_BWRAP_BIN: BOGUS_BIN,
      FACTORY_EXEC_SANDBOX_RO_BINDS: '/usr, /srv/toolchain ',
    });
    assert.equal(c.bwrapBin, BOGUS_BIN);
    assert.deepEqual(c.extraRoBinds, ['/usr', '/srv/toolchain']);
  });
});

describe('buildExecSandboxPrefix', () => {
  const base = { bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'], network: true };
  it('shares the host network by default and binds cwd at its real path', () => {
    const p = buildExecSandboxPrefix('/tmp/wd', base);
    assert.ok(!p.includes('--unshare-net'), 'network must be shared by default');
    assert.ok(p.includes('/etc/resolv.conf'), 'shared network needs DNS');
    const dashdash = p.indexOf('--');
    assert.equal(dashdash, p.length - 1, 'prefix must end with --');
    const bindIdx = p.indexOf('--bind');
    assert.equal(p[bindIdx + 1], '/tmp/wd');
    assert.equal(p[bindIdx + 2], '/tmp/wd', 'cwd bound at its real path (not /work)');
    assert.equal(p[p.indexOf('--chdir') + 1], '/tmp/wd');
    assert.ok(p.includes('--setenv') && p[p.indexOf('--setenv') + 2] === '/tmp');
  });
  it('network=false adds --unshare-net and drops DNS binds', () => {
    const p = buildExecSandboxPrefix('/tmp/wd', { ...base, network: false });
    assert.ok(p.includes('--unshare-net'));
    assert.ok(!p.includes('/etc/resolv.conf'));
  });
  it('rejects non-absolute cwd', () => {
    assert.throws(() => buildExecSandboxPrefix('rel/path', base));
    assert.throws(() => buildExecSandboxPrefix('', base));
  });
});

describe('decideExecSandbox', () => {
  it('disabled config → mode disabled, empty prefix, no probe', async () => {
    const d = await decideExecSandbox('/tmp', {
      enabled: false,
      mode: 'workspace-write',
      network: true,
      bwrapBin: BOGUS_BIN,
      extraRoBinds: ['/usr', '/opt'],
    });
    assert.equal(d.mode, 'disabled');
    assert.deepEqual(d.prefix, []);
    assert.equal(d.reason, null);
    assert.equal(d.refused, false);
  });
  it('bogus bwrap → refused SANDBOX_UNAVAILABLE (fail-closed, no fallback)', async () => {
    resetExecSandboxProbeCacheForTests();
    try {
      const d = await decideExecSandbox('/tmp', {
        enabled: true,
        mode: 'workspace-write',
        network: true,
        bwrapBin: BOGUS_BIN,
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(d.refused, true);
      assert.equal(d.refuseCode, 'SANDBOX_UNAVAILABLE');
      assert.equal(d.mode, 'workspace-write');
      assert.deepEqual(d.prefix, []);
      assert.ok(d.reason && d.reason.length > 0, 'refusal must carry a reason');
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });
});

/**
 * A fake bwrap for wiring tests: verifies the sandbox argv shape
 * (ends in '--', carries the expected confinement flags) and then
 * exec's the real command WITHOUT any isolation. This proves the
 * prefix is applied end-to-end; it proves nothing about real
 * isolation (see the module's honest-boundaries header).
 */
function writeFakeBwrap(dir: string): string {
  const bin = join(dir, 'fake-bwrap');
  writeFileSync(
    bin,
    `#!/bin/sh
# fake bwrap: argv-shape assertion + passthrough (NO isolation)
has() { for a in "$@"; do [ "$a" = "$1" ] && return 0; shift; done; return 1; }
has "--" || { echo "fake-bwrap: argv must contain --" >&2; exit 99; }
{ has "--unshare-user" || has "--unshare-all"; } || { echo "fake-bwrap: missing namespace unshare" >&2; exit 99; }
has "--die-with-parent" || { echo "fake-bwrap: missing --die-with-parent" >&2; exit 99; }
# strip our flags: everything up to and including the first "--"
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
echo "fake-bwrap: sandboxed"
exec "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('sandboxed execution wiring (fake bwrap)', () => {
  let dir = '';
  let fakeBin = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-sb-test-'));
    fakeBin = writeFakeBwrap(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decideExecSandbox with a working fake bwrap → mode workspace-write + usable prefix', async () => {
    resetExecSandboxProbeCacheForTests();
    try {
      // The fake bwrap cannot pass the REAL probe (it would try to run
      // /usr/bin/true through the passthrough — actually it can: the
      // fake exec's its args, and /usr/bin/true exits 0). The probe
      // therefore succeeds, exercising the decision path.
      const d = await decideExecSandbox(dir, {
        enabled: true,
        mode: 'workspace-write',
        network: true,
        bwrapBin: fakeBin,
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(d.mode, 'workspace-write');
      assert.equal(d.sandboxed, true);
      assert.equal(d.refused, false);
      assert.ok(d.prefix.length > 0);
      assert.equal(d.prefix[d.prefix.length - 1], '--');
      assert.equal(d.prefix[0], fakeBin);
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });

  it('runCommandPipe applies argvPrefix end-to-end (runtime wiring)', async () => {
    // Imported lazily so this file stays server-test-shaped; the
    // runtime dist is built by the root build.
    const { runCommandPipe } = await import('@ai-factory/runtime');
    const d = await decideExecSandbox(dir, {
      enabled: true,
      mode: 'workspace-write',
      network: true,
      bwrapBin: fakeBin,
      extraRoBinds: ['/usr', '/opt'],
    });
    resetExecSandboxProbeCacheForTests();
    const r = await runCommandPipe(['/bin/echo', 'hello-sandbox'], {
      cwd: dir,
      timeoutMs: 15000,
      argvPrefix: d.prefix,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /fake-bwrap: sandboxed/);
    assert.match(r.stdout, /hello-sandbox/);
  });
});

/* ------------------------------------------------------------------ */
/* Route-level: fail-closed is NEVER silent (real server boot)         */
/* ------------------------------------------------------------------ */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const serverChildren: ChildProcess[] = [];

async function bootServerWithEnv(
  dir: string,
  extraEnv: Record<string, string>,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  serverChildren.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in 20000ms');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('route-level fail-closed (real server, bogus bwrap)', () => {
  it("POST /api/exec → 403 SANDBOX_UNAVAILABLE, honestly marked in response AND audit", async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine).
    const dir = mkdtempSync(join(homedir(), 'exec-sb-route-'));
    const { child, port } = await bootServerWithEnv(dir, {
      FACTORY_BWRAP_BIN: BOGUS_BIN,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'echo hello-sandbox-refused', actor: 'human' }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'SANDBOX_UNAVAILABLE');
      // The refusal is honestly marked in the RESPONSE — never silent.
      assert.equal(body['sandbox'], 'workspace-write');

      // …and in the AUDIT record.
      const auditRes = await fetch(`http://127.0.0.1:${port}/api/audit?limit=50`);
      assert.equal(auditRes.status, 200);
      const records = (await auditRes.json()) as Array<{
        action: string;
        details?: Record<string, unknown>;
      }>;
      const denied = records.find((r) => r.action === 'EXEC_DENIED');
      assert.ok(denied, 'expected an EXEC_DENIED audit record');
      assert.equal(denied.details?.['reason'], 'SANDBOX_UNAVAILABLE');
      assert.equal(denied.details?.['sandbox'], 'workspace-write');
      assert.ok(
        String(denied.details?.['sandboxReason'] ?? '').length > 0,
        'refusal audit must carry the probe reason',
      );
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminal session create is refused too (no unisolated session)', async () => {
    const dir = mkdtempSync(join(homedir(), 'exec-sb-route-term-'));
    const { child, port } = await bootServerWithEnv(dir, {
      FACTORY_BWRAP_BIN: BOGUS_BIN,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ principal: 'human', actor: 'human' }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'SANDBOX_UNAVAILABLE');
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
