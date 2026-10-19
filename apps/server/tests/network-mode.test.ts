/**
 * Offline mode (network gate) tests.
 *
 * Unit: NetworkModeStore (persistence, corrupt fail-open, env override,
 * atomic write, error shape) — network-mode.ts is node-builtins only,
 * so it imports straight from src (dual-mode import rule).
 *
 * Scheduler: webhook jobs skip with NETWORK_OFFLINE when the injected
 * isOffline() is true (fetchWebhook never called) — scheduler.ts stays
 * pure, the dep is injected.
 *
 * E2E: boots the real server (dist) with an isolated DATA_DIR:
 *   GET /api/network/mode → 200 {offline:false}
 *   POST /api/network/offline {enabled:true} → 200, audited
 *   POST /api/search → 403 NETWORK_OFFLINE
 *   POST /api/mcp/remote/connect → 403 NETWORK_OFFLINE
 *   POST /api/mcp/remote/call → 403 NETWORK_OFFLINE
 *   POST /api/exec (bwrap forced unavailable) → 403 NETWORK_OFFLINE
 *     (refused, never run unisolated — no fake offline)
 *   POST /api/network/offline {enabled:false} → back online
 *   POST /api/search → no longer NETWORK_OFFLINE
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/network-mode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Dual-mode import rule: both modules value-import only node builtins —
// safe to import from src directly.
import {
  NETWORK_OFFLINE_CODE,
  NetworkModeStore,
  assertOnline,
  networkOfflineError,
  resetNetworkModeForTests,
} from '../src/network-mode.ts';
import { ScheduleStore, TaskScheduler, type SchedulerDeps } from '../src/scheduler.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

// ------------------------------------------------------------- unit --

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-netmode-'));
  return path.join(dir, 'network-mode.json');
}

test('NetworkModeStore: set/get round-trip + reload persistence', () => {
  const file = tmpFile();
  const s = new NetworkModeStore(file);
  assert.equal(s.isOffline(), false);
  const next = s.setOffline(true, 'human');
  assert.equal(next.offline, true);
  assert.equal(next.updatedBy, 'human');
  assert.ok(next.updatedAt.length > 0);
  assert.equal(s.isOffline(), true);
  // A new instance reads the persisted file.
  const s2 = new NetworkModeStore(file);
  assert.equal(s2.isOffline(), true);
  assert.equal(s2.get().updatedBy, 'human');
  s2.setOffline(false, 'human');
  assert.equal(new NetworkModeStore(file).isOffline(), false);
});

test('NetworkModeStore: corrupt file fails open to online (never bricks)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json', 'utf8');
  const s = new NetworkModeStore(file);
  assert.equal(s.isOffline(), false);
  // Wrong shape also falls back.
  fs.writeFileSync(file, JSON.stringify({ offline: 'yes' }), 'utf8');
  assert.equal(new NetworkModeStore(file).isOffline(), false);
});

test('NetworkModeStore: FACTORY_NETWORK_OFFLINE=1 forces offline', () => {
  const file = tmpFile();
  const s = new NetworkModeStore(file);
  s.setOffline(false, 'human');
  assert.equal(s.isOffline({}), false);
  assert.equal(s.isOffline({ FACTORY_NETWORK_OFFLINE: '1' }), true);
  assert.equal(s.isOffline({ FACTORY_NETWORK_OFFLINE: 'true' }), true);
  // Falsy values do not force.
  assert.equal(s.isOffline({ FACTORY_NETWORK_OFFLINE: '0' }), false);
  assert.equal(s.isOffline({ FACTORY_NETWORK_OFFLINE: '' }), false);
});

test('NetworkModeStore: set writes valid JSON atomically (no tmp leftovers)', () => {
  const file = tmpFile();
  const dir = path.dirname(file);
  const s = new NetworkModeStore(file);
  s.setOffline(true, 'tester');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as { offline: boolean };
  assert.equal(parsed.offline, true);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('networkOfflineError: plain Error with the NETWORK_OFFLINE code', () => {
  assert.equal(NETWORK_OFFLINE_CODE, 'NETWORK_OFFLINE');
  const e = networkOfflineError('web_search');
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'NETWORK_OFFLINE');
  assert.match(e.message, /offline mode/);
  assert.match(e.message, /web_search/);
});

test('assertOnline: throws when offline, no-op when online', () => {
  resetNetworkModeForTests();
  const file = tmpFile();
  const s = new NetworkModeStore(file);
  // Online: no throw.
  assert.doesNotThrow(() => {
    if (s.isOffline()) throw networkOfflineError('x');
  });
  s.setOffline(true, 'human');
  assert.equal(s.isOffline(), true);
  // assertOnline uses the module singleton — point it at our file via env.
  process.env.AI_FACTORY_NETWORK_MODE_FILE = file;
  resetNetworkModeForTests();
  assert.throws(() => assertOnline('web_search'), /offline mode is enabled/);
  delete process.env.AI_FACTORY_NETWORK_MODE_FILE;
  resetNetworkModeForTests();
});

// ------------------------------------------------------- scheduler --

function makeWebhookDeps(storePath: string, isOffline: boolean): {
  deps: SchedulerDeps;
  webhookCalls: unknown[];
  audits: { event: string }[];
} {
  const webhookCalls: unknown[] = [];
  const audits: { event: string }[] = [];
  const deps: SchedulerDeps = {
    store: new ScheduleStore(storePath),
    audit: {
      record: (actor, event, entityType, entityId, details) => {
        audits.push({ event });
      },
    },
    createTask: () => ({ id: 'task-1' }),
    startRun: async () => ({ runId: 'run-1' }),
    runBackup: () => ({ backupId: 'backup-1' }),
    fetchWebhook: async (url, opts) => {
      webhookCalls.push({ url, opts });
      return { status: 200, body: 'ok' };
    },
    isOffline: () => isOffline,
  };
  return { deps, webhookCalls, audits };
}

test('scheduler: webhook job skips with NETWORK_OFFLINE when offline (no dial-out)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-sched-offline-'));
  const { deps, webhookCalls, audits } = makeWebhookDeps(
    path.join(dir, 'schedules.json'),
    true,
  );
  const sched = new TaskScheduler(deps);
  const s = deps.store.create({
    name: 'ping',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'webhook', url: 'https://example.com/hook' },
  });
  const result = await sched.trigger(s.id);
  assert.equal(result.ok, false);
  assert.match(result.summary, /NETWORK_OFFLINE/);
  assert.equal(webhookCalls.length, 0, 'fetchWebhook must never be called while offline');
  assert.ok(audits.some((a) => a.event === 'SCHEDULE_FIRED'), 'skip is audited via SCHEDULE_FIRED');
  assert.ok(audits.some((a) => a.event === 'SCHEDULE_FAILED'), 'skip is audited via SCHEDULE_FAILED');
});

test('scheduler: webhook job still dials out when online', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-sched-online-'));
  const { deps, webhookCalls } = makeWebhookDeps(path.join(dir, 'schedules.json'), false);
  const sched = new TaskScheduler(deps);
  const s = deps.store.create({
    name: 'ping',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'webhook', url: 'https://example.com/hook' },
  });
  const result = await sched.trigger(s.id);
  assert.equal(result.ok, true);
  assert.equal(webhookCalls.length, 1);
});

// ---------------------------------------------------------------- e2e --

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-netmode-e2e-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
    // Force the bwrap probe to fail so the offline exec gate takes the
    // refusal path deterministically (no bwrap on PATH in this env anyway).
    FACTORY_BWRAP_BIN: '/nonexistent/bwrap-for-test',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS', 'FACTORY_NETWORK_OFFLINE']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not come up');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, proc, dir };
}

async function postJson(base: string, p: string, body: unknown) {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('e2e: offline switch gates every egress with NETWORK_OFFLINE', async () => {
  const running = await startServer();
  try {
    const base = `http://127.0.0.1:${running.port}`;

    // Starts online.
    const m0Res = await fetch(`${base}/api/network/mode`);
    const m0 = (await m0Res.json()) as Record<string, unknown>;
    assert.equal(m0.offline, false);

    // Flip the switch.
    const on = await postJson(base, '/api/network/offline', { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.offline, true);

    // The flip is audited.
    const auditRes = await fetch(`${base}/api/audit?limit=50`);
    const audit = (await auditRes.json()) as {
      action: string;
    }[];
    assert.ok(
      audit.some((r) => r.action === 'NETWORK_MODE_CHANGED'),
      'NETWORK_MODE_CHANGED is in the audit trail',
    );

    // Every egress fails closed with the machine-readable code.
    const search = await postJson(base, '/api/search', { query: 'hello' });
    assert.equal(search.status, 403);
    assert.equal(search.body.code, 'NETWORK_OFFLINE');

    const conn = await postJson(base, '/api/mcp/remote/connect', { name: 'x', version: 'y' });
    assert.equal(conn.status, 403);
    assert.equal(conn.body.code, 'NETWORK_OFFLINE');

    const call = await postJson(base, '/api/mcp/remote/call', { name: 'x', tool: 'y' });
    assert.equal(call.status, 403);
    assert.equal(call.body.code, 'NETWORK_OFFLINE');

    // Exec: bwrap forced unavailable → refused, never run unisolated.
    const exec = await postJson(base, '/api/exec', { command: 'echo hi', actor: 'human' });
    assert.equal(exec.status, 403);
    assert.equal(exec.body.code, 'NETWORK_OFFLINE');

    // Bad body → 400, not a silent no-op.
    const bad = await postJson(base, '/api/network/offline', { enabled: 'yes' });
    assert.equal(bad.status, 400);

    // Flip back: egress works again (search may 502 on provider failure,
    // but it must NOT be NETWORK_OFFLINE).
    const off = await postJson(base, '/api/network/offline', { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.offline, false);
    const search2 = await postJson(base, '/api/search', { query: 'hello' });
    assert.notEqual(search2.body.code, 'NETWORK_OFFLINE');
  } finally {
    running.proc.kill('SIGKILL');
    fs.rmSync(running.dir, { recursive: true, force: true });
  }
});
