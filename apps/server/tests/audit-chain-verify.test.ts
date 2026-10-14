/**
 * GET /api/audit/verify — §32 chain verification endpoint (Batch 53, F33).
 *
 * The Batch 52 walkthrough found the server had no HTTP verify endpoint
 * ("the server is the writer, the operator is the reader"); F33 noted a
 * future endpoint must anchor at genesis. This pins the contract over pure
 * HTTP against the real built server, zero mocks:
 *
 *   1. Intact chain → 200 {ok:true, verifiedCount, legacyCount:0}, no
 *      brokenAt key.
 *   2. A record tampered directly in the SQLite file (second node:sqlite
 *      connection — the "attacker with DB access"; there is intentionally
 *      no HTTP mutation path) → 200 {ok:false, brokenAt, verifiedCount},
 *      brokenAt pinpointing the tampered record's append-order index.
 *   3. Pagination is refused, not silently truncated: ?limit=2 → 400
 *      {code:'AUDIT_VERIFY_NO_PAGINATION'} (F33: a truncated window would
 *      falsely report brokenAt:0).
 *   4. Role gating (auth mode): viewer → 403, operator → 200.
 *
 * Requires the workspace build (root `npm run build`): boots ../dist/index.js.
 * Hermetic: temp DB + temp FACTORY_SECRETS_DIR so the developer's local vault
 * is never touched. Dual-mode: node builtins + fetch only, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

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

interface Booted {
  child: ChildProcess;
  port: number;
  dbFile: string;
}

async function bootServer(extraEnv: Record<string, string> = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-audit-verify-'));
  const dbFile = join(dir, 'factory.db');
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault (fail-closed without it on stale local data).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_API_TOKENS' in extraEnv)) delete env['FACTORY_API_TOKENS'];
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
      if (res.ok) return { child, port, dbFile };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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

async function makeRecords(port: number, names: string[], token?: string): Promise<void> {
  for (const name of names) {
    const r = await api(port, 'POST', '/api/projects', { name }, token);
    assert.equal(r.status, 201, `POST /api/projects ${name}`);
  }
}

/** Newest-first bare array (F21 contract) → append order, the chain's order. */
async function readChainAppendOrder(port: number, token?: string): Promise<Array<Json & { id: string }>> {
  const r = await api(port, 'GET', '/api/audit?limit=200', undefined, token);
  assert.equal(r.status, 200, 'GET /api/audit');
  assert.ok(Array.isArray(r.body), 'F21: /api/audit returns a bare array');
  return (r.body as Array<Json & { id: string }>).slice().reverse();
}

describe('GET /api/audit/verify (§32 chain verification, Batch 53)', () => {
  it('intact chain → ok:true with full counts, no brokenAt', { timeout: 60_000 }, async () => {
    const { port } = await bootServer();
    await makeRecords(port, ['verify-a', 'verify-b', 'verify-c']);

    const r = await api(port, 'GET', '/api/audit/verify');
    assert.equal(r.status, 200, 'GET /api/audit/verify');
    assert.equal(r.body['ok'], true, 'intact chain must verify');
    assert.ok(
      typeof r.body['verifiedCount'] === 'number' && (r.body['verifiedCount'] as number) >= 3,
      `expected verifiedCount ≥ 3, got ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body['legacyCount'], 0, 'fresh DB: every record carries chain fields');
    assert.ok(
      !('brokenAt' in r.body),
      `brokenAt must be absent when ok:true, got ${JSON.stringify(r.body)}`,
    );
  });

  it('tampered record → ok:false, brokenAt pinpoints the record', { timeout: 60_000 }, async () => {
    const { port, dbFile } = await bootServer();
    await makeRecords(port, ['verify-t1', 'verify-t2', 'verify-t3']);

    const chain = await readChainAppendOrder(port);
    assert.ok(chain.length >= 3, `expected ≥3 records, got ${chain.length}`);
    // Tamper a middle record (append-order index 2): the break must be
    // located exactly there, and everything before it must still verify.
    const tamperIdx = 2;
    const tamperedId = chain[tamperIdx].id;
    assert.ok(typeof tamperedId === 'string' && tamperedId.length > 0, 'tamper target has an id');

    // Second connection — the "attacker with DB access". The server is
    // idle between HTTP calls; retry briefly on SQLITE_BUSY rather than
    // assuming the lock state (same pattern as the Batch 52 walkthrough).
    let tampered = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 10 && !tampered; attempt++) {
      const db = new DatabaseSync(dbFile);
      try {
        db.prepare('UPDATE audit_logs SET details = ? WHERE id = ?').run(
          JSON.stringify({ tampered: true, note: 'verify test rewrote this record' }),
          tamperedId,
        );
        tampered = true;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        db.close();
      }
    }
    assert.ok(tampered, `direct DB tamper failed: ${String(lastErr)}`);

    const r = await api(port, 'GET', '/api/audit/verify');
    assert.equal(r.status, 200, 'GET /api/audit/verify');
    assert.equal(r.body['ok'], false, 'tampered chain must NOT verify');
    assert.equal(
      r.body['brokenAt'],
      tamperIdx,
      `brokenAt must pinpoint the tampered record (index ${tamperIdx}), got ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body['verifiedCount'],
      tamperIdx,
      'records before the break still verify',
    );
  });

  it('pagination is refused, not silently truncated (F33)', { timeout: 60_000 }, async () => {
    const { port } = await bootServer();
    await makeRecords(port, ['verify-p1']);

    const limited = await api(port, 'GET', '/api/audit/verify?limit=2');
    assert.equal(limited.status, 400, '?limit must be refused');
    assert.equal(
      limited.body['code'],
      'AUDIT_VERIFY_NO_PAGINATION',
      `expected AUDIT_VERIFY_NO_PAGINATION, got ${JSON.stringify(limited.body)}`,
    );

    const offset = await api(port, 'GET', '/api/audit/verify?offset=5');
    assert.equal(offset.status, 400, '?offset must be refused');
    assert.equal(offset.body['code'], 'AUDIT_VERIFY_NO_PAGINATION');
  });

  it('role gating: viewer → 403, operator → 200', { timeout: 60_000 }, async () => {
    const { port } = await bootServer({
      FACTORY_API_TOKENS: 'viewer:verify-viewer,operator:verify-operator',
    });
    await makeRecords(port, ['verify-r1'], 'verify-operator');

    const viewer = await api(port, 'GET', '/api/audit/verify', undefined, 'verify-viewer');
    assert.equal(viewer.status, 403, 'viewer must be denied');

    const operator = await api(port, 'GET', '/api/audit/verify', undefined, 'verify-operator');
    assert.equal(operator.status, 200, 'operator must be allowed');
    assert.equal(operator.body['ok'], true, 'operator sees an intact chain');
  });
});
