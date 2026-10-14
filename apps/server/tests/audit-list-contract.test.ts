/**
 * GET /api/audit response-shape contract (Batch 46, F21).
 *
 * Formal contract: the endpoint returns a BARE JSON ARRAY of audit records,
 * newest first; `limit` caps the count (default 100). It is NEVER an envelope
 * ({records:[...]} / {items:[...]}). ~27 server tests plus the /api/evidence
 * sibling consume the bare array; any future shape change is a breaking API
 * change. This test nails the contract over pure HTTP against the real
 * built server, zero mocks.
 *
 * Requires the workspace build (root `npm run build`): boots ../dist/index.js.
 * Hermetic: temp DB + temp FACTORY_SECRETS_DIR so the developer's local vault
 * is never touched.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface Booted {
  child: ChildProcess;
  port: number;
}

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

async function bootServer(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-audit-contract-'));
  const dbFile = join(dir, 'factory.db');
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault (fail-closed without it on stale local data).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
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
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function postProject(port: number, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `POST /api/projects ${name}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function getAudit(port: number, qs: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit${qs}`);
  assert.equal(res.status, 200, `GET /api/audit${qs}`);
  return await res.json();
}

describe('GET /api/audit response-shape contract (F21)', () => {
  it('returns a bare array, newest first — never an envelope', { timeout: 60_000 }, async () => {
    const { port } = await bootServer();
    const ids = [
      await postProject(port, 'audit-shape-a'),
      await postProject(port, 'audit-shape-b'),
      await postProject(port, 'audit-shape-c'),
    ];

    // 1. Bare array, not an envelope. This is the tripwire: if anyone wraps
    // the response in {records:[...]} or {items:[...]}, this fails loudly.
    const body = await getAudit(port, '?limit=50');
    assert.ok(
      Array.isArray(body),
      `expected a bare JSON array, got ${typeof body}: ${JSON.stringify(body).slice(0, 120)}`,
    );
    const rows = body as Array<Record<string, unknown>>;

    // 2. Newest first: the three PROJECT_CREATED records head the list in
    // reverse creation order (they are the newest audit events).
    const created = rows.filter((r) => r['action'] === 'PROJECT_CREATED');
    assert.ok(created.length >= 3, `expected >=3 PROJECT_CREATED, got ${created.length}`);
    const gotIds = created.slice(0, 3).map((r) => r['entityId']);
    assert.deepEqual(
      gotIds,
      [ids[2], ids[1], ids[0]],
      'audit list is newest-first',
    );

    // 3. `limit` caps the count.
    const limited = (await getAudit(port, '?limit=2')) as Array<unknown>;
    assert.ok(Array.isArray(limited), 'limited response is also a bare array');
    assert.equal(limited.length, 2, 'limit=2 returns exactly 2 records');
  });
});
