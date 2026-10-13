/**
 * MCP launch-record history across restarts — §46 (Batch 26).
 *
 * Until Batch 26 the launcher's process table was pure process
 * memory: a restart forgot every launch. Now every spawn/stop/exit
 * lands a row in fdb's mcp_launch_records, and a restart marks the
 * previous boot's still-RUNNING rows ORPHANED instead of forgetting
 * them. Pinned on the REAL server binary (boot → SIGKILL → reboot on
 * the same DB file):
 *
 *  - boot A: register -> approve (AUTO) -> install -> launch a
 *    long-running sleeper (RUNNING row), launch a quick-exiting
 *    process (EXITED row), launch another sleeper and /stop it
 *    (STOPPED row);
 *  - SIGKILL boot A, boot B on the same DB:
 *  - GET /api/mcp/launches (live) is EMPTY — no process is managed;
 *  - GET /api/mcp/launches?history=true shows the sleeper as
 *    ORPHANED (with an honest "fate unknown" note), plus the
 *    STOPPED and EXITED rows from boot A, unchanged;
 *  - the persisted rows carry ref NAMES only — the secret value
 *    never reaches disk.
 *
 * Honest boundary pinned here: ORPHANED means "the owning launcher
 * process is gone; the child process's real fate is unknown". We
 * never claim the child is dead, and we never claim it is alive.
 *
 * Boots dist/index.js, so this file runs after the server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'mcp-launch-rec-admin-xyz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const SECRET_VALUE = 'launch-rec-sentinel-value-must-never-reach-disk';

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 28_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: `admin:${ADMIN}`,
    FACTORY_SECRETS_BACKEND: 'memory',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Rec = Record<string, unknown>;

describe('MCP launch records survive restarts (§46, Batch 26)', () => {
  it('launch rows persist; restart marks the live one ORPHANED, keeps STOPPED/EXITED', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-launch-rec-'));
    const dbFile = join(dir, 'factory.db');
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const name = `launchrec-probe-${suffix}`;
    const version = '1.0.0';

    const call = async (port: number, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Rec = {};
      try { parsed = JSON.parse(text) as Rec; } catch { /* non-JSON */ }
      return { status: res.status, body: parsed };
    };

    const history = async (port: number): Promise<Rec[]> => {
      const r = await call(port, 'GET', '/api/mcp/launches?history=true');
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      return (r.body.launches as Rec[]) ?? [];
    };

    let boot1: { child: ChildProcess; port: number } | undefined;
    let boot2: { child: ChildProcess; port: number } | undefined;
    try {
      boot1 = await bootRealServer(dbFile);
      // Register (BLOCKED) -> approve (AUTO) -> install.
      const reg = await call(boot1.port, 'POST', '/api/mcp/register', {
        server: {
          name, version, provider: 'local', transport: 'stdio',
          tools: [{ name: 'probe' }],
          credentialRefs: ['LAUNCH_REC_REF'],
        },
      });
      assert.equal(reg.status, 201, JSON.stringify(reg.body).slice(0, 300));
      const ap = await call(boot1.port, 'POST', `/api/mcp/servers/${name}@${version}/trust/approve`, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO', reviewer: 'human',
      });
      assert.equal(ap.status, 200, JSON.stringify(ap.body).slice(0, 300));
      const ins = await call(boot1.port, 'POST', '/api/mcp/install', { name, version });
      assert.equal(ins.status, 200, JSON.stringify(ins.body).slice(0, 300));

      // Seed the secret backend so secretEnv injection has a value.
      const put = await call(boot1.port, 'PUT', '/api/secrets/LAUNCH_REC_REF', {
        value: SECRET_VALUE, purpose: 'launch-record probe',
      });
      assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));

      // 1) Long-running sleeper -> RUNNING row.
      const sleeper = await call(boot1.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
        secretEnv: { LAUNCH_REC_VAR: 'LAUNCH_REC_REF' },
      });
      assert.equal(sleeper.status, 201, JSON.stringify(sleeper.body).slice(0, 300));
      const sleeperId = sleeper.body.launchId as string;

      // 2) Quick-exiting process -> EXITED row (wait for the exit event).
      const quick = await call(boot1.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', '1'],
      });
      assert.equal(quick.status, 201, JSON.stringify(quick.body).slice(0, 300));
      const quickId = quick.body.launchId as string;
      {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const rows = await history(boot1.port);
          const row = rows.find((r) => r.id === quickId);
          if (row?.status === 'EXITED') break;
          if (Date.now() > deadline) throw new Error('quick launch never reached EXITED');
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // 3) Another sleeper, then /stop it -> STOPPED row.
      const doomed = await call(boot1.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      });
      assert.equal(doomed.status, 201, JSON.stringify(doomed.body).slice(0, 300));
      const doomedId = doomed.body.launchId as string;
      const stop = await call(boot1.port, 'POST', `/api/mcp/launches/${doomedId}/stop`, {});
      assert.equal(stop.status, 200, JSON.stringify(stop.body).slice(0, 300));
      {
        const rows = await history(boot1.port);
        assert.equal(rows.find((r) => r.id === doomedId)?.status, 'STOPPED');
      }

      // The persisted history already carries the secret REF name —
      // and never the value.
      {
        const rows = await history(boot1.port);
        const blob = JSON.stringify(rows);
        assert.ok(blob.includes('LAUNCH_REC_REF'), 'ref name is persisted');
        assert.ok(!blob.includes(SECRET_VALUE), 'secret VALUE must never reach the launch record');
      }

      // SIGKILL boot A — the sleeper's OS process may survive, but the
      // launcher that owned it is gone.
      boot1.child.kill('SIGKILL');
      await new Promise((r) => boot1!.child.once('exit', r));
      boot1 = undefined;

      // Boot B on the same DB.
      boot2 = await bootRealServer(dbFile);

      // Live table is empty: nothing is managed by this process.
      const live = await call(boot2.port, 'GET', '/api/mcp/launches');
      assert.equal(live.status, 200);
      assert.deepEqual(live.body.launches, [], 'no launch is managed after a restart');

      // History: the sleeper is ORPHANED (fate unknown, not managed);
      // STOPPED and EXITED rows are unchanged.
      const rows = await history(boot2.port);
      const byId = new Map(rows.map((r) => [r.id as string, r]));
      assert.equal(byId.get(sleeperId)?.status, 'ORPHANED');
      assert.ok(
        String(byId.get(sleeperId)?.orphanNote ?? '').includes('fate is unknown'),
        'orphan note states the honest unknown',
      );
      assert.equal(byId.get(quickId)?.status, 'EXITED');
      assert.equal(byId.get(doomedId)?.status, 'STOPPED');
      // The ORPHANED row keeps the launch parameters for inspection.
      // (command is stored resolved — the launcher resolves it on PATH.)
      assert.ok(String(byId.get(sleeperId)?.command ?? '').endsWith('/node')); 
      assert.deepEqual(JSON.parse(String(byId.get(sleeperId)?.argsJson ?? '[]')), ['-e', 'setTimeout(()=>{},60000)']);
      // Secret value still absent after the restart.
      assert.ok(!JSON.stringify(rows).includes(SECRET_VALUE));

      // A fresh launch after the restart gets a NEW row (ORPHANED is
      // terminal — we never resurrect it).
      const fresh = await call(boot2.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      });
      assert.equal(fresh.status, 201, JSON.stringify(fresh.body).slice(0, 300));
      const freshId = fresh.body.launchId as string;
      assert.notEqual(freshId, sleeperId);
      const rows2 = await history(boot2.port);
      assert.equal(rows2.find((r) => r.id === freshId)?.status, 'RUNNING');
      assert.equal(rows2.find((r) => r.id === sleeperId)?.status, 'ORPHANED');

      // Clean up the fresh sleeper.
      await call(boot2.port, 'POST', `/api/mcp/launches/${freshId}/stop`, {});
    } finally {
      if (boot1) { boot1.child.kill('SIGKILL'); await new Promise((r) => boot1!.child.once('exit', r)); }
      if (boot2) { boot2.child.kill('SIGKILL'); await new Promise((r) => boot2!.child.once('exit', r)); }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
