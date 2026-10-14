/**
 * Walkthrough: audit-chain verify leg (Batch 54).
 *
 * Batch 52's integrity leg proved the §32 hash chain detects tampering, but
 * only via a client-side verifier ("the server is the writer, the operator
 * is the reader"). Batch 53 closed F33 by adding `GET /api/audit/verify`
 * (operator/admin): the server itself verifies its full chain anchored at
 * genesis. This leg is the first-run proof that the endpoint does what the
 * contract test pins — pure HTTP, zero mocks, real compiled server over a
 * fresh temp SQLite file.
 *
 *   V1. three real `POST /api/projects` → `GET /api/audit/verify` →
 *       200 `ok:true`, `verifiedCount` ≥ 3, `legacyCount:0`, no `brokenAt`.
 *   V2. one middle record's `details` rewritten directly in the SQLite
 *       file via a second `node:sqlite` connection — the "attacker with DB
 *       access"; there is intentionally no HTTP mutation path → re-fetch
 *       `GET /api/audit/verify` → 200 `ok:false`, `brokenAt` pinpointing
 *       the tampered record's append-order index (found by id, not
 *       assumed), `verifiedCount` exactly the records before the break.
 *   V3. `GET /api/audit/verify?limit=1` → 400
 *       `AUDIT_VERIFY_NO_PAGINATION` — the fail-closed refusal that keeps
 *       F33's spurious-brokenAt:0 from ever reaching a verifier.
 *
 * The honest claim is unchanged: detection-not-prevention. The endpoint
 * verifies the server's local chain; it cannot stop a DB writer, it makes
 * the tamper evident and locates it.
 *
 * Requires the workspace build (root `npm run build`): boots ../dist/index.js.
 * Hermetic: temp DB + temp FACTORY_SECRETS_DIR so the developer's local
 * vault is never touched. Dual-mode: node builtins + fetch + node:sqlite
 * only, zero src imports.
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

async function bootServer(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-verify-walk-'));
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
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
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

describe('Walkthrough: audit-chain verify leg (Batch 54, F33 closed)', () => {
  it('V1–V3: endpoint verifies, detects tamper, refuses pagination', { timeout: 120_000 }, async () => {
    const { port, dbFile } = await bootServer();

    // V1: intact chain → the endpoint verifies its own chain, anchored at genesis.
    for (const name of ['verify-walk-a', 'verify-walk-b', 'verify-walk-c']) {
      const r = await api(port, 'POST', '/api/projects', { name });
      assert.equal(r.status, 201, `POST /api/projects ${name}`);
    }
    const intact = await api(port, 'GET', '/api/audit/verify');
    assert.equal(intact.status, 200, 'GET /api/audit/verify');
    assert.equal(intact.body['ok'], true, 'V1: intact chain must verify');
    assert.ok(
      typeof intact.body['verifiedCount'] === 'number' &&
        (intact.body['verifiedCount'] as number) >= 3,
      `V1: verifiedCount ≥ 3, got ${JSON.stringify(intact.body)}`,
    );
    assert.equal(intact.body['legacyCount'], 0, 'V1: fresh DB, every record chained');
    assert.ok(
      !('brokenAt' in intact.body),
      `V1: brokenAt must be absent when ok:true, got ${JSON.stringify(intact.body)}`,
    );

    // V2: tamper directly in the file → the endpoint itself reports the break.
    // Read the chain newest-first (F21 bare-array contract), reverse to the
    // append order the chain commits to, and pick a middle record by id.
    const list = await api(port, 'GET', '/api/audit?limit=200');
    assert.equal(list.status, 200, 'GET /api/audit');
    const appendOrder = (list.body as Array<{ id: string }>).slice().reverse();
    assert.ok(appendOrder.length >= 3, `expected ≥3 records, got ${appendOrder.length}`);
    const tamperIdx = Math.floor(appendOrder.length / 2);
    const tamperedId = appendOrder[tamperIdx].id;

    // Second connection — the "attacker with DB access". Retry briefly on
    // SQLITE_BUSY rather than assuming the lock state.
    let tampered = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 10 && !tampered; attempt++) {
      const db = new DatabaseSync(dbFile);
      try {
        db.prepare('UPDATE audit_logs SET details = ? WHERE id = ?').run(
          JSON.stringify({ tampered: true, note: 'verify walkthrough rewrote this record' }),
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
    assert.ok(tampered, `V2: direct DB tamper failed: ${String(lastErr)}`);

    const broken = await api(port, 'GET', '/api/audit/verify');
    assert.equal(broken.status, 200, 'GET /api/audit/verify after tamper');
    assert.equal(broken.body['ok'], false, 'V2: tampered chain must NOT verify');
    assert.equal(
      broken.body['brokenAt'],
      tamperIdx,
      `V2: brokenAt must pinpoint the tampered record (index ${tamperIdx}), got ${JSON.stringify(broken.body)}`,
    );
    assert.equal(
      broken.body['verifiedCount'],
      tamperIdx,
      'V2: records before the break still verify',
    );

    // V3: pagination is refused, not silently truncated (F33 fail-closed).
    const limited = await api(port, 'GET', '/api/audit/verify?limit=1');
    assert.equal(limited.status, 400, 'V3: ?limit must be refused');
    assert.equal(
      limited.body['code'],
      'AUDIT_VERIFY_NO_PAGINATION',
      `V3: expected AUDIT_VERIFY_NO_PAGINATION, got ${JSON.stringify(limited.body)}`,
    );
  });
});
