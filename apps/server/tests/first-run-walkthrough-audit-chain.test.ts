/**
 * First-run walkthrough: audit-chain integrity leg (Batch 52-2).
 *
 * The §32 hash chain (packages/core/src/audit.ts) is a core invariant —
 * "audit is append-only and immutable" — but no walkthrough ever verified
 * end-to-end that *tampering with an audit record is detected*. This leg
 * does exactly that against the real compiled server over a fresh temp
 * SQLite file, pure HTTP, zero mocks:
 *
 *   A1 — intact chain: real API calls (3× POST /api/projects) produce
 *        audit records; GET /api/audit (bare array, newest first — the
 *        Batch 46 F21 contract) is reversed to append order and verified
 *        client-side with the real compiled @ai-factory/core
 *        verifyAuditChain → ok:true, every record chained (legacyCount 0).
 *        There is deliberately no HTTP verify endpoint: the server is the
 *        writer, the operator/verifier is the reader — the chain is
 *        verified where it is consumed.
 *   A2 — content tamper: one record's `details` is rewritten *directly in
 *        the SQLite file* (node:sqlite, a second connection — the exact
 *        "attacker with DB access" the append-only design defends
 *        against; there is intentionally no HTTP mutation path).
 *        Re-fetch → verifyAuditChain → ok:false and `brokenAt` pinpoints
 *        the tampered record's index. Detection, not prevention, is the
 *        honest claim: the chain cannot stop a DB writer, it makes the
 *        tamper evident and locates it.
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 52 section,
 * F32+). Requires the workspace build (root `npm run build`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyAuditChain } from '@ai-factory/core';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

interface AuditRow extends Json {
  id: string;
  ts: string;
  actor: string;
  action: string;
  summaryHash?: string;
  prevHash?: string;
}

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

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets: point the file vault at a temp dir so the walk
    // never inherits the developer's local (git-ignored) vault.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b52-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
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
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

/** Newest-first bare array → append order (the order the chain commits to). */
async function readChain(port: number): Promise<AuditRow[]> {
  const r = await api(port, 'GET', '/api/audit?limit=200');
  assert.equal(r.status, 200, 'GET /api/audit');
  assert.ok(Array.isArray(r.body), 'F21: /api/audit returns a bare array');
  return (r.body as AuditRow[]).slice().reverse();
}

// ------------------------------------------------------------------ the leg --

describe('walkthrough: audit-chain integrity (Batch 52)', () => {
  it('intact chain verifies; a directly-tampered record is detected and located', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b52-'));
    const dbFile = join(dir, 'factory.db');
    const server = await bootServer(dbFile);
    try {
      // ---- A1: produce real audit records over pure HTTP ----
      for (const name of ['walk-b52-a', 'walk-b52-b', 'walk-b52-c']) {
        const r = await api(server.port, 'POST', '/api/projects', { name });
        assert.equal(r.status, 201, `POST /api/projects ${name}`);
      }

      const chain = await readChain(server.port);
      assert.ok(chain.length >= 3, `expected ≥3 audit records, got ${chain.length}`);
      const intact = verifyAuditChain(chain);
      assert.equal(intact.ok, true, 'intact chain must verify');
      assert.equal(intact.legacyCount, 0, 'fresh DB: every record carries chain fields');
      assert.equal(
        intact.verifiedCount,
        chain.length,
        'every record in the fresh chain verifies',
      );

      // ---- A2: tamper one record directly in the SQLite file ----
      // The tamper target is a middle record (append-order index 2): the
      // chain before it must still verify, and the break must be located
      // exactly at its index.
      const tamperIdx = 2;
      const tamperedId = chain[tamperIdx].id;
      assert.ok(typeof tamperedId === 'string' && tamperedId.length > 0, 'tamper target has an id');

      // A second connection — the "attacker with DB access". The server is
      // idle between HTTP calls; retry briefly on SQLITE_BUSY rather than
      // assuming the lock state.
      let tampered = false;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 10 && !tampered; attempt++) {
        const db = new DatabaseSync(dbFile);
        try {
          db.prepare(`UPDATE audit_logs SET details = ? WHERE id = ?`).run(
            JSON.stringify({ tampered: true, note: 'walk-b52 rewrote this record' }),
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

      const chain2 = await readChain(server.port);
      // No new records should have been appended between the two reads;
      // locate the tampered record by id rather than assuming the index.
      const tamperIdx2 = chain2.findIndex((r) => r.id === tamperedId);
      assert.equal(tamperIdx2, tamperIdx, 'no records appended between reads');

      const after = verifyAuditChain(chain2);
      assert.equal(after.ok, false, 'tampered chain must NOT verify');
      assert.equal(
        after.brokenAt,
        tamperIdx2,
        `brokenAt must pinpoint the tampered record (index ${tamperIdx2})`,
      );
      assert.equal(chain2[after.brokenAt as number].id, tamperedId, 'brokenAt record is the tampered one');
      // Records before the break still verify: verifiedCount counts exactly
      // the chained records up to (not including) the break.
      assert.equal(after.verifiedCount, tamperIdx2, 'records before the break still verify');
    } finally {
      await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
