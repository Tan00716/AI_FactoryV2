/**
 * removeServer atomic unit + orphan cleanup end to end — Batch 28.
 *
 * Boots the real server (dist/index.js), registers + approves +
 * installs a real stdio server, injects an orphan install row
 * directly into the shared DB file (simulating a racing writer's
 * saveInstall that landed after a remove committed — the case the
 * old two-statement remove silently wiped, and the new atomic unit
 * converts into an observable orphan), then POST /api/mcp/remove.
 *
 * Asserts:
 *  - the registration AND its install row are gone (atomic unit);
 *  - the injected orphan is gone too (defensive scan);
 *  - MCP_INSTALL_ORPHAN_CLEANED is in the audit log (loud, never
 *    silent), naming the orphan;
 *  - MCP_REMOVED is still recorded (existing behavior unchanged).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'remove-admin-ccc';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 27_000 + Math.floor(Math.random() * 18_000);
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

async function stopRealServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
}

function withRetry<T>(fn: () => T): T {
  let last: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      const msg = (e as Error).message ?? '';
      if (!/SQLITE_BUSY|database is locked/i.test(msg)) throw e;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw last;
}

describe('POST /api/mcp/remove sweeps orphan installs loudly (Batch 28)', () => {
  it('atomic remove + orphan cleanup + MCP_INSTALL_ORPHAN_CLEANED audit', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-remove-e2e-'));
    const dbFile = join(dir, 'factory.db');
    const { child, port } = await bootRealServer(dbFile);
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: res.status, body: parsed };
    };
    const name = `removeme-${Date.now()}`;
    const version = '1.0.0';
    try {
      const reg = await call('POST', '/api/mcp/register', {
        server: { name, version, provider: 'local', transport: 'stdio' },
      });
      assert.equal(reg.status, 201);
      const ap = await call('POST', `/api/mcp/servers/${name}@${version}/trust/approve`, {
        trustLevel: 'HIGH',
        approvalPolicy: 'AUTO',
      });
      assert.equal(ap.status, 200);
      const ins = await call('POST', '/api/mcp/install', { name, version });
      assert.ok(ins.status === 200 || ins.status === 202, `install -> ${ins.status}`);

      // Inject the orphan directly (a racing writer's row on a
      // registration that no longer exists).
      const probe = new DatabaseSync(dbFile);
      try {
        probe.exec('PRAGMA busy_timeout = 10000');
        withRetry(() =>
          probe
            .prepare(
              `INSERT INTO mcp_installs (name, version, status, installed_at, scope_enabled_json, last_used_version)
               VALUES (?, ?, 'INSTALLED', ?, '{}', ?)`,
            )
            .run('ghost-orphan', '9.9.9', '2026-10-13T00:00:00.000Z', '9.9.9'),
        );
      } finally {
        probe.close();
      }

      const rm = await call('POST', '/api/mcp/remove', { name, version });
      assert.equal(rm.status, 200);
      assert.equal(rm.body.ok, true);

      // The registration and its own install are gone (atomic unit)…
      const probe2 = new DatabaseSync(dbFile);
      try {
        probe2.exec('PRAGMA busy_timeout = 10000');
        const rows = withRetry(() =>
          probe2.prepare('SELECT name, version FROM mcp_installs').all() as Array<{ name: string; version: string }>,
        );
        const keys = rows.map((r) => `${r.name}@${r.version}`);
        assert.ok(!keys.includes(`${name}@${version}`), 'legit install removed with registration');
        assert.ok(!keys.includes('ghost-orphan@9.9.9'), 'orphan swept by the defensive scan');
        const servers = withRetry(() =>
          probe2.prepare('SELECT 1 FROM mcp_servers WHERE name = ? AND version = ?').get(name, version),
        );
        assert.equal(servers, undefined, 'registration gone');
      } finally {
        probe2.close();
      }

      // …and the cleanup is loud.
      const audit = await call('GET', '/api/audit?limit=200');
      assert.equal(audit.status, 200);
      const events = audit.body as unknown as Array<{ action: string; details?: unknown }>;
      const cleaned = events.find((e) => e.action === 'MCP_INSTALL_ORPHAN_CLEANED');
      assert.ok(cleaned, 'MCP_INSTALL_ORPHAN_CLEANED audited');
      assert.ok(
        JSON.stringify(cleaned.details).includes('ghost-orphan@9.9.9'),
        'audit names the removed orphan',
      );
      assert.ok(events.some((e) => e.action === 'MCP_REMOVED'), 'MCP_REMOVED still recorded');
    } finally {
      await stopRealServer(child);
    }
  });
});
