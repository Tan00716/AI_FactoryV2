/**
 * OS-enforced sandbox tiers (sandbox-modes.ts + exec-sandbox.ts).
 *
 * Unit (src-direct imports — sandbox-modes.ts value-imports only node
 * builtins + a type import, per the dual-mode rule):
 *   - resolveSandboxMode: project config → env → persisted store
 *   - readProjectSandboxConfig: upward search, allowDanger only via file
 *   - SandboxModeStore: persistence round-trip, corrupt → safe default
 *   - checkDangerExec / validateDangerApproval: gate matrix with a real
 *     ApprovalManager (in-memory store)
 *
 * Wiring (compiled dist — exec-sandbox.ts value-imports build-sandbox):
 *   - buildReadOnlySandboxPrefix: --ro-bind cwd, no --bind
 *   - decideExecSandbox: fail-closed matrix (bogus bwrap → refused with
 *     SANDBOX_UNAVAILABLE; danger → direct by design, no probe;
 *     fake bwrap → sandboxed prefix per tier)
 *
 * E2E (real server boot, dist):
 *   - GET /api/sandbox/mode → 200; POST → 200 + SANDBOX_MODE_SET audit
 *   - POST invalid mode → 400
 *   - POST /api/exec with bwrap unavailable → 403 SANDBOX_UNAVAILABLE
 *     (fail-closed — the old 'none (fallback)' run-anyway is gone)
 *   - danger flow: project .ai-factory/sandbox.json {mode, allowDanger}
 *     → 403 DANGER_APPROVAL_REQUIRED + approvalId → approve via
 *     /api/approvals/:id/decision → retry with dangerApprovalId → 200,
 *     sandbox='danger-full-access', one-shot (reuse → 403)
 *   - danger without allowDanger → 403 DANGER_NOT_CONFIGURED
 *
 * Honest note: bwrap is NOT installed on this machine, so true
 * kernel-enforced isolation cannot be demonstrated here. The tier
 * wiring (prefix shape, fail-closed refusal, approval binding) is
 * proven with a fake bwrap (passthrough, no isolation — argv-shape
 * asserted) exactly like exec-sandbox.test.ts does.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/sandbox-modes.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// src-direct: node-builtins only (dual-mode rule).
import {
  DANGER_APPROVAL_INVALID_CODE,
  DANGER_APPROVAL_NEVER_CODE,
  DANGER_APPROVAL_REQUIRED_CODE,
  DANGER_NOT_CONFIGURED_CODE,
  SANDBOX_UNAVAILABLE_CODE,
  SandboxModeStore,
  checkDangerExec,
  dangerCommandDigest,
  isApprovalPolicy,
  isSandboxMode,
  readProjectSandboxConfig,
  resetDangerConsumedForTests,
  resetSandboxModeStoreForTests,
  resolveSandboxMode,
  sandboxModeStrictness,
  validateDangerApproval,
  SANDBOX_MODE_FILE_ENV,
} from '../src/sandbox-modes.ts';
// dist: exec-sandbox.ts value-imports ./build-sandbox (dual-mode rule).
import {
  buildReadOnlySandboxPrefix,
  decideExecSandbox,
  execSandboxConfigFromEnv,
  resetExecSandboxProbeCacheForTests,
} from '../dist/exec-sandbox.js';
import { ApprovalManager } from '@ai-factory/approvals';

const BOGUS_BIN = '/nonexistent/bwrap-sandbox-modes-xyz';

function tmpSandboxFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-mode-'));
  return join(dir, 'sandbox-mode.json');
}

function withSandboxFileEnv(file: string, fn: () => void): void {
  const prev = process.env[SANDBOX_MODE_FILE_ENV];
  process.env[SANDBOX_MODE_FILE_ENV] = file;
  resetSandboxModeStoreForTests();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[SANDBOX_MODE_FILE_ENV];
    else process.env[SANDBOX_MODE_FILE_ENV] = prev;
    resetSandboxModeStoreForTests();
  }
}

describe('type guards + strictness', () => {
  it('isSandboxMode / isApprovalPolicy', () => {
    assert.equal(isSandboxMode('read-only'), true);
    assert.equal(isSandboxMode('workspace-write'), true);
    assert.equal(isSandboxMode('danger-full-access'), true);
    assert.equal(isSandboxMode('bwrap'), false);
    assert.equal(isSandboxMode(''), false);
    assert.equal(isApprovalPolicy('on-request'), true);
    assert.equal(isApprovalPolicy('never'), true);
    assert.equal(isApprovalPolicy('sometimes'), false);
  });
  it('strictness order: read-only < workspace-write < danger-full-access', () => {
    assert.ok(sandboxModeStrictness('read-only') < sandboxModeStrictness('workspace-write'));
    assert.ok(sandboxModeStrictness('workspace-write') < sandboxModeStrictness('danger-full-access'));
  });
  it('dangerCommandDigest is stable and command-bound', () => {
    assert.equal(dangerCommandDigest('echo hi'), dangerCommandDigest('echo hi'));
    assert.notEqual(dangerCommandDigest('echo hi'), dangerCommandDigest('echo ho'));
    assert.equal(dangerCommandDigest('echo hi').length, 16);
  });
});

describe('readProjectSandboxConfig', () => {
  let dir = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-proj-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('missing file → {}', () => {
    assert.deepEqual(readProjectSandboxConfig(dir), {});
  });
  it('parses mode + allowDanger; walks up from a subdir', () => {
    const proj = join(dir, 'proj1');
    mkdirSync(join(proj, '.ai-factory'), { recursive: true });
    mkdirSync(join(proj, 'sub', 'deep'), { recursive: true });
    writeFileSync(
      join(proj, '.ai-factory', 'sandbox.json'),
      JSON.stringify({ mode: 'danger-full-access', allowDanger: true }),
    );
    const cfg = readProjectSandboxConfig(join(proj, 'sub', 'deep'));
    assert.equal(cfg.mode, 'danger-full-access');
    assert.equal(cfg.allowDanger, true);
  });
  it('allowDanger must be exactly true; invalid fields ignored', () => {
    const proj = join(dir, 'proj2');
    mkdirSync(join(proj, '.ai-factory'), { recursive: true });
    writeFileSync(
      join(proj, '.ai-factory', 'sandbox.json'),
      JSON.stringify({ mode: 'nope', allowDanger: 'yes', approvalPolicy: 'never' }),
    );
    const cfg = readProjectSandboxConfig(proj);
    assert.equal(cfg.mode, undefined);
    assert.equal(cfg.allowDanger, undefined);
    assert.equal(cfg.approvalPolicy, 'never');
  });
  it('unparsable file → {} (fail-safe defaults)', () => {
    const proj = join(dir, 'proj3');
    mkdirSync(join(proj, '.ai-factory'), { recursive: true });
    writeFileSync(join(proj, '.ai-factory', 'sandbox.json'), '{oops');
    assert.deepEqual(readProjectSandboxConfig(proj), {});
  });
});

describe('SandboxModeStore', () => {
  it('round-trip set/get with atomic write', () => {
    const file = tmpSandboxFile();
    const s = new SandboxModeStore(file);
    assert.equal(s.get().mode, 'workspace-write');
    assert.equal(s.get().approvalPolicy, 'on-request');
    const next = s.set('read-only', 'never', 'human');
    assert.equal(next.mode, 'read-only');
    assert.equal(next.approvalPolicy, 'never');
    assert.equal(next.updatedBy, 'human');
    const s2 = new SandboxModeStore(file);
    assert.equal(s2.get().mode, 'read-only');
    rmSync(join(file, '..'), { recursive: true, force: true });
  });
  it('corrupt file → safe default (workspace-write / on-request)', () => {
    const file = tmpSandboxFile();
    writeFileSync(file, 'not json{{');
    const s = new SandboxModeStore(file);
    assert.equal(s.get().mode, 'workspace-write');
    assert.equal(s.get().approvalPolicy, 'on-request');
    rmSync(join(file, '..'), { recursive: true, force: true });
  });
});

describe('resolveSandboxMode', () => {
  it('default: workspace-write from the store', () => {
    withSandboxFileEnv(tmpSandboxFile(), () => {
      const r = resolveSandboxMode(tmpdir(), {});
      assert.equal(r.mode, 'workspace-write');
      assert.equal(r.source, 'store');
      assert.equal(r.approvalPolicy, 'on-request');
      assert.equal(r.allowDanger, false);
    });
  });
  it('env wins over the store', () => {
    withSandboxFileEnv(tmpSandboxFile(), () => {
      const r = resolveSandboxMode(tmpdir(), { FACTORY_SANDBOX_MODE: 'read-only' });
      assert.equal(r.mode, 'read-only');
      assert.equal(r.source, 'env');
    });
  });
  it('project config wins over env; env cannot grant allowDanger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-res-'));
    try {
      mkdirSync(join(dir, '.ai-factory'), { recursive: true });
      writeFileSync(
        join(dir, '.ai-factory', 'sandbox.json'),
        JSON.stringify({ mode: 'danger-full-access', allowDanger: true }),
      );
      withSandboxFileEnv(tmpSandboxFile(), () => {
        const r = resolveSandboxMode(dir, { FACTORY_SANDBOX_MODE: 'read-only' });
        assert.equal(r.mode, 'danger-full-access');
        assert.equal(r.source, 'project');
        assert.equal(r.allowDanger, true);
      });
      // Same dir, no project file for allowDanger: env mode → allowDanger false.
      const dir2 = mkdtempSync(join(tmpdir(), 'sb-res2-'));
      try {
        withSandboxFileEnv(tmpSandboxFile(), () => {
          const r2 = resolveSandboxMode(dir2, { FACTORY_SANDBOX_MODE: 'danger-full-access' });
          assert.equal(r2.mode, 'danger-full-access');
          assert.equal(r2.allowDanger, false, 'env must never grant allowDanger');
        });
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('invalid env value falls through to the store', () => {
    withSandboxFileEnv(tmpSandboxFile(), () => {
      const r = resolveSandboxMode(tmpdir(), { FACTORY_SANDBOX_MODE: 'yolo' });
      assert.equal(r.mode, 'workspace-write');
      assert.equal(r.source, 'store');
    });
  });
});

describe('danger gate (real ApprovalManager, in-memory store)', () => {
  let dir = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-danger-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function freshManager(): ApprovalManager {
    return new ApprovalManager();
  }

  it('allowDanger=false → DANGER_NOT_CONFIGURED (no ticket minted)', () => {
    resetDangerConsumedForTests();
    const m = freshManager();
    const before = m.list().length;
    const r = checkDangerExec({
      manager: m,
      actor: 'human',
      command: 'echo hi',
      allowDanger: false,
      approvalPolicy: 'on-request',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, DANGER_NOT_CONFIGURED_CODE);
    assert.equal(m.list().length, before, 'must not mint a ticket when not configured');
  });

  it('approvalPolicy=never → DANGER_APPROVAL_NEVER', () => {
    const m = freshManager();
    const r = checkDangerExec({
      manager: m,
      actor: 'human',
      command: 'echo hi',
      allowDanger: true,
      approvalPolicy: 'never',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, DANGER_APPROVAL_NEVER_CODE);
  });

  it('no ticket → mints PENDING bound to the command; approve → one-shot use', () => {
    resetDangerConsumedForTests();
    const m = freshManager();
    const cmd = 'echo danger-ok';
    const r1 = checkDangerExec({
      manager: m,
      actor: 'human',
      command: cmd,
      allowDanger: true,
      approvalPolicy: 'on-request',
      taskId: 'task-unit-test',
    });
    assert.equal(r1.ok, false);
    if (r1.ok) throw new Error('unreachable');
    assert.equal(r1.code, DANGER_APPROVAL_REQUIRED_CODE);
    assert.ok(r1.approvalId, 'must mint an approval id');
    const ticket = m.get(r1.approvalId!);
    assert.equal(ticket.status, 'PENDING');
    assert.equal(ticket.risk_level, 'CRITICAL');
    assert.equal(ticket.candidate_digest, dangerCommandDigest(cmd), 'ticket bound to the command');
    assert.equal(ticket.task_id, 'task-unit-test', 'ticket bound to the task (FK)');

    // Human approves.
    m.decide(r1.approvalId!, { approved: true, decided_by: 'human' });

    // First use: ok.
    const r2 = checkDangerExec({
      manager: m,
      actor: 'human',
      command: cmd,
      allowDanger: true,
      approvalPolicy: 'on-request',
      dangerApprovalId: r1.approvalId,
    });
    assert.equal(r2.ok, true);

    // Second use: consumed → invalid (one-shot).
    const r3 = checkDangerExec({
      manager: m,
      actor: 'human',
      command: cmd,
      allowDanger: true,
      approvalPolicy: 'on-request',
      dangerApprovalId: r1.approvalId,
    });
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, DANGER_APPROVAL_INVALID_CODE);
  });

  it('no taskId → no mint (FK): returns manual-mint instructions + candidateDigest', () => {
    resetDangerConsumedForTests();
    const m = freshManager();
    const cmd = 'echo no-task';
    const before = m.list().length;
    const r = checkDangerExec({
      manager: m,
      actor: 'human',
      command: cmd,
      allowDanger: true,
      approvalPolicy: 'on-request',
      // no taskId, no dangerApprovalId
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.code, DANGER_APPROVAL_REQUIRED_CODE);
    assert.equal(r.approvalId, undefined, 'must NOT mint without a task (FK)');
    assert.equal(r.candidateDigest, dangerCommandDigest(cmd));
    assert.match(r.message, /POST \/api\/approvals/);
    assert.equal(m.list().length, before, 'no ticket minted');
  });

  it('ticket bound to another command → invalid', () => {
    resetDangerConsumedForTests();
    const m = freshManager();
    const r1 = checkDangerExec({
      manager: m,
      actor: 'human',
      command: 'echo one',
      allowDanger: true,
      approvalPolicy: 'on-request',
      taskId: 'task-unit-test',
    });
    if (r1.ok || !r1.approvalId) throw new Error('expected a minted ticket');
    m.decide(r1.approvalId, { approved: true, decided_by: 'human' });
    const r2 = validateDangerApproval(m, r1.approvalId, 'rm -rf /');
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, DANGER_APPROVAL_INVALID_CODE);
  });

  it('unknown approval id → invalid', () => {
    const m = freshManager();
    const r = validateDangerApproval(m, 'nope', 'echo hi');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, DANGER_APPROVAL_INVALID_CODE);
  });
});

describe('buildReadOnlySandboxPrefix', () => {
  const base = { bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'], network: true };
  it('binds cwd --ro-bind (never --bind), ends with --', () => {
    const p = buildReadOnlySandboxPrefix('/tmp/wd', base);
    assert.equal(p[p.length - 1], '--');
    const roIdx = p.indexOf('--ro-bind');
    assert.ok(roIdx >= 0, 'must contain --ro-bind');
    assert.equal(p[roIdx + 1], '/tmp/wd');
    assert.equal(p[roIdx + 2], '/tmp/wd');
    assert.equal(p.indexOf('--bind'), -1, 'read-only must never use --bind');
    assert.equal(p[p.indexOf('--chdir') + 1], '/tmp/wd');
    // Still a tmpfs /tmp so commands can function.
    assert.ok(p.includes('--tmpfs') && p[p.indexOf('--tmpfs') + 1] === '/tmp');
  });
  it('rejects non-absolute cwd', () => {
    assert.throws(() => buildReadOnlySandboxPrefix('rel', base));
  });
});

describe('decideExecSandbox tier matrix', () => {
  it('config now carries mode (default workspace-write)', () => {
    const c = execSandboxConfigFromEnv({});
    assert.equal(c.mode, 'workspace-write');
  });
  it('bogus bwrap + workspace-write → refused SANDBOX_UNAVAILABLE (fail-closed)', async () => {
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
      assert.equal(d.refuseCode, SANDBOX_UNAVAILABLE_CODE);
      assert.equal(d.mode, 'workspace-write');
      assert.equal(d.sandboxed, false);
      assert.deepEqual(d.prefix, []);
      assert.ok(d.reason && d.reason.length > 0);
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });
  it('bogus bwrap + read-only → refused too (no fake isolation)', async () => {
    resetExecSandboxProbeCacheForTests();
    try {
      const d = await decideExecSandbox('/tmp', {
        enabled: true,
        mode: 'read-only',
        network: true,
        bwrapBin: BOGUS_BIN,
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(d.refused, true);
      assert.equal(d.refuseCode, SANDBOX_UNAVAILABLE_CODE);
      assert.equal(d.mode, 'read-only');
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });
  it('danger → direct by design: no probe, not refused, empty prefix', async () => {
    const d = await decideExecSandbox('/tmp', {
      enabled: true,
      mode: 'danger-full-access',
      network: true,
      bwrapBin: BOGUS_BIN, // would fail the probe — must not be consulted
      extraRoBinds: ['/usr', '/opt'],
    });
    assert.equal(d.refused, false);
    assert.equal(d.mode, 'danger-full-access');
    assert.equal(d.sandboxed, false);
    assert.deepEqual(d.prefix, []);
  });
});

/**
 * Fake bwrap (passthrough, NO isolation — argv-shape assertion only),
 * extended to assert the read-only tier never uses --bind.
 */
function writeFakeBwrap(dir: string): string {
  const bin = join(dir, 'fake-bwrap');
  writeFileSync(
    bin,
    `#!/bin/sh
# NOTE: has() does a REAL membership check: the needle ($1) is
# shifted off, then the caller's "$@" is scanned (the call sites pass
# "$@" explicitly — a bare has call with only the needle would never
# match). An earlier version compared each arg against the shifting $1
# and was vacuously true, which broke the probe.
has() { _n="$1"; shift; for _a in "$@"; do [ "$_a" = "$_n" ] && return 0; done; return 1; }
has "--" "$@" || { echo "fake-bwrap: argv must contain --" >&2; exit 99; }
{ has "--unshare-user" "$@" || has "--unshare-all" "$@"; } || { echo "fake-bwrap: missing namespace unshare" >&2; exit 99; }
has "--die-with-parent" "$@" || { echo "fake-bwrap: missing --die-with-parent" >&2; exit 99; }
if has "--ro-bind" "$@"; then
  has "--bind" "$@" && { echo "fake-bwrap: read-only tier must not use --bind" >&2; exit 99; }
fi
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
echo "fake-bwrap: sandboxed"
exec "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('tier wiring (fake bwrap)', () => {
  let dir = '';
  let fakeBin = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-tier-'));
    fakeBin = writeFakeBwrap(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('read-only tier → sandboxed with --ro-bind prefix', async () => {
    resetExecSandboxProbeCacheForTests();
    try {
      const d = await decideExecSandbox(dir, {
        enabled: true,
        mode: 'read-only',
        network: true,
        bwrapBin: fakeBin,
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(d.refused, false);
      assert.equal(d.sandboxed, true);
      assert.equal(d.mode, 'read-only');
      assert.ok(d.prefix.includes('--ro-bind'));
      assert.equal(d.prefix.indexOf('--bind'), -1);
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });

  it('workspace-write tier → sandboxed with --bind prefix', async () => {
    resetExecSandboxProbeCacheForTests();
    try {
      const d = await decideExecSandbox(dir, {
        enabled: true,
        mode: 'workspace-write',
        network: true,
        bwrapBin: fakeBin,
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(d.sandboxed, true);
      assert.equal(d.mode, 'workspace-write');
      assert.ok(d.prefix.includes('--bind'));
    } finally {
      resetExecSandboxProbeCacheForTests();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Route-level (real server boot, dist)                                */
/* ------------------------------------------------------------------ */

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
    AI_FACTORY_SANDBOX_MODE_FILE: join(dir, 'sandbox-mode.json'),
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

after(async () => {
  for (const c of serverChildren) await stopChild(c);
});

describe('route: /api/sandbox/mode', () => {
  it('GET → 200 default; POST sets tier + audits SANDBOX_MODE_SET; bad mode → 400', async () => {
    const dir = mkdtempSync(join(homedir(), 'sb-route-mode-'));
    const { child, port } = await bootServerWithEnv(dir, {});
    try {
      let res = await fetch(`http://127.0.0.1:${port}/api/sandbox/mode`);
      assert.equal(res.status, 200);
      let body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['mode'], 'workspace-write');
      assert.equal(body['persistedMode'], 'workspace-write');

      res = await fetch(`http://127.0.0.1:${port}/api/sandbox/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'read-only' }),
      });
      assert.equal(res.status, 200);
      body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['persistedMode'], 'read-only');

      const auditRes = await fetch(`http://127.0.0.1:${port}/api/audit?limit=50`);
      const records = (await auditRes.json()) as Array<{ action: string }>;
      assert.ok(records.some((r) => r.action === 'SANDBOX_MODE_SET'), 'SANDBOX_MODE_SET audited');

      res = await fetch(`http://127.0.0.1:${port}/api/sandbox/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'yolo' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('route: fail-closed exec without bwrap', () => {
  it("POST /api/exec → 403 SANDBOX_UNAVAILABLE (never runs unisolated)", async () => {
    const dir = mkdtempSync(join(homedir(), 'sb-route-fail-'));
    const { child, port } = await bootServerWithEnv(dir, {
      FACTORY_BWRAP_BIN: BOGUS_BIN,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'echo hello-fail-closed', actor: 'human' }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], SANDBOX_UNAVAILABLE_CODE);

      const auditRes = await fetch(`http://127.0.0.1:${port}/api/audit?limit=50`);
      const records = (await auditRes.json()) as Array<{
        action: string;
        details?: Record<string, unknown>;
      }>;
      const denied = records.find((r) => r.action === 'EXEC_DENIED');
      assert.ok(denied, 'expected an EXEC_DENIED audit record');
      assert.equal(denied.details?.['reason'], SANDBOX_UNAVAILABLE_CODE);
      assert.equal(denied.details?.['sandbox'], 'workspace-write');
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('route: danger tier end-to-end', () => {
  it('mint → approve → run once (one-shot) → DANGER_NOT_CONFIGURED without allowDanger', async () => {
    const dir = mkdtempSync(join(homedir(), 'sb-route-danger-'));
    // The exec route's cwd policy requires the cwd to stay inside the
    // server's workspace root (its process cwd). A homedir() temp dir
    // would 403 without a code before the sandbox logic runs — so the
    // danger projects live in a throwaway dir under the workspace root
    // and are removed in the finally block.
    const wsTmp = mkdtempSync(join(serverCwd, '.sb-danger-'));
    // Project with danger enabled.
    const proj = join(wsTmp, 'proj');
    mkdirSync(join(proj, '.ai-factory'), { recursive: true });
    writeFileSync(
      join(proj, '.ai-factory', 'sandbox.json'),
      JSON.stringify({ mode: 'danger-full-access', allowDanger: true }),
    );
    const { child, port } = await bootServerWithEnv(dir, {});
    // The danger gate mints task-bound tickets (approvals.task_id FK),
    // so the exec calls carry a real projectId; the route auto-creates
    // a clearly-labeled anchor task per mint.
    let res0 = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DangerProj' }),
    });
    assert.equal(res0.status, 201);
    const projRow = (await res0.json()) as Record<string, unknown>;
    const projectId = String(projRow['id'] ?? '');
    assert.ok(projectId, 'expected a project id');
    const execBody = (extra: Record<string, unknown>) =>
      JSON.stringify({ command: 'echo danger-run', cwd: proj, actor: 'human', projectId, ...extra });
    try {
      // 1) No ticket → 403 DANGER_APPROVAL_REQUIRED + minted approvalId.
      let res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: execBody({}),
      });
      assert.equal(res.status, 403);
      let body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'DANGER_APPROVAL_REQUIRED');
      const approvalId = String(body['approvalId'] ?? '');
      assert.ok(approvalId, 'expected a minted approvalId');

      // 2) Human approves via the approvals API.
      res = await fetch(`http://127.0.0.1:${port}/api/approvals/${approvalId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true, decided_by: 'human' }),
      });
      assert.equal(res.status, 200);

      // 3) Retry with the ticket → 200, runs directly, honestly marked.
      res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: execBody({ dangerApprovalId: approvalId }),
      });
      assert.equal(res.status, 200);
      body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['ok'], true);
      assert.equal(body['sandbox'], 'danger-full-access');
      assert.match(String(body['output'] ?? ''), /danger-run/);

      // 4) Reuse → 403 (one-shot).
      res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: execBody({ dangerApprovalId: approvalId }),
      });
      assert.equal(res.status, 403);
      body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'DANGER_APPROVAL_INVALID');

      // 5) Project WITHOUT allowDanger → DANGER_NOT_CONFIGURED.
      const proj2 = join(wsTmp, 'proj2');
      mkdirSync(join(proj2, '.ai-factory'), { recursive: true });
      writeFileSync(
        join(proj2, '.ai-factory', 'sandbox.json'),
        JSON.stringify({ mode: 'danger-full-access' }),
      );
      res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'echo no', cwd: proj2, actor: 'human', projectId }),
      });
      assert.equal(res.status, 403);
      body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'DANGER_NOT_CONFIGURED');

      // 6) No projectId → no auto-mint (nothing to bind the ticket to):
      // 403 DANGER_APPROVAL_REQUIRED + candidateDigest, no approvalId.
      res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'echo manual', cwd: proj, actor: 'human' }),
      });
      assert.equal(res.status, 403);
      body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'DANGER_APPROVAL_REQUIRED');
      assert.equal(body['approvalId'], undefined);
      assert.ok(typeof body['candidateDigest'] === 'string' && body['candidateDigest'].length === 16);
      assert.match(String(body['error'] ?? ''), /POST \/api\/approvals/);
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });
});
