/**
 * Batch 49 — builtin tool definitions are pre-registered at server boot.
 *
 * What this pins (pure HTTP, zero mocks, against the real compiled server
 * over a fresh temp SQLite file):
 *
 *  1. `GET /api/tools` lists the 16 shipped §33 builtin definitions with
 *     no operator registration step (previously it returned [] until an
 *     operator hand-registered every definition).
 *  2. `POST /api/tools/execute` for a server-wired tool (runtime.echo)
 *     SUCCEEDS with no prior registration — the pre-registration is
 *     metadata only; execution still goes through the implementation
 *     gate, the server runner and capability checks.
 *  3. A definition-only builtin (fs.read) is still DENIED with
 *     UNSUPPORTED_CAPABILITY — pre-registration does not weaken the gate.
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

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-tools-pre-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
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

const PRINCIPAL = { id: 'p1', kind: 'human' };
const CAPABILITY = {
  id: 'cap1',
  principalId: 'p1',
  actions: ['runtime.echo'],
  resourcePrefixes: [''],
  revoked: false,
};

describe('builtin tool definitions pre-registered at boot (Batch 49)', () => {
  it(
    'GET /api/tools lists 16 builtins; wired tools execute; definition-only still denied',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-tools-pre-'));
      let server: { child: ChildProcess; port: number } | undefined;
      try {
        server = await bootServer(join(dir, 'factory.db'));
        const port = server.port;

        const list = await api(port, 'GET', '/api/tools');
        assert.equal(list.status, 200);
        const tools = list.body['tools'] as Array<Json>;
        assert.equal(tools.length, 16, `16 builtin definitions pre-registered, got ${tools.length}`);
        assert.ok(tools.some((t) => t['id'] === 'runtime.echo'), 'runtime.echo listed');

        const echo = await api(port, 'POST', '/api/tools/execute', {
          toolId: 'runtime.echo',
          action: 'runtime.echo',
          resource: 'test',
          principal: PRINCIPAL,
          capability: CAPABILITY,
          args: { msg: 'hello' },
        });
        assert.equal(echo.status, 200);
        assert.equal(echo.body['outcome'], 'SUCCEEDED');
        assert.equal(echo.body['stdout'], 'hello');

        const denied = await api(port, 'POST', '/api/tools/execute', {
          toolId: 'fs.read',
          action: 'read',
          resource: 'test',
          principal: PRINCIPAL,
          capability: CAPABILITY,
          args: {},
        });
        assert.equal(denied.status, 200);
        assert.equal(denied.body['outcome'], 'DENIED');
        assert.match(String(denied.body['note'] ?? ''), /UNSUPPORTED_CAPABILITY/);
      } finally {
        if (server) {
          server.child.kill('SIGKILL');
          await new Promise((r) => server!.child.once('exit', r));
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
