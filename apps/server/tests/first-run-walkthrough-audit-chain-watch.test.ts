/**
 * Walkthrough: audit-chain watch leg (Batch 56).
 *
 * Batch 55 added the periodic §32 self-check (F36): the server verifies
 * its own chain in-process — once at boot plus a 60s setInterval — and
 * raises one §81 'security-issue' needsHuman when the chain breaks. The
 * module-level contract was pinned by audit-chain-watch.test.ts (6/6),
 * and the boot behavior was verified once by hand. This leg pins the
 * real startup path end to end: the actual compiled server process is
 * booted (the boot-time check is the same tickAuditChainWatch index.ts
 * calls at top level), the DB is tampered out-of-band, and the server
 * is rebooted — pure HTTP, zero mocks, fresh temp SQLite files.
 *
 *   A. healthy DB boot → GET /api/needs-human?status=open → 0 items
 *      (the watch is silent on success, no audit spam).
 *   B. tamper a middle record via a second node:sqlite connection (the
 *      "attacker with DB access"), reboot the same DB → boot check
 *      raises exactly 1 OPEN security-issue (source=audit-chain-watch,
 *      severity=critical, requiredDeciderLevel=operator, honest
 *      narrative persisted in detailJson). Reboot a third time while
 *      still broken → still exactly 1 OPEN (dedup: list('open') is the
 *      authority, no storm; AUDIT_CHAIN_VERIFY_FAILED written once).
 *   C. same tamper, reboot with FACTORY_AUDIT_CHAIN_WATCH=0 → 0 OPEN
 *      (the watch does not run). GET /api/audit/verify → ok:false on
 *      the same DB proves 0 OPEN is because the watch is off, not
 *      because the tamper failed.
 *
 * Choice note: this test boots the real server process rather than
 * calling tickAuditChainWatch at module level because the claimed
 * behavior is "the server self-checks on boot" — the closest path to
 * the claim is an actual boot. The 60s interval timer is live during
 * the test (defaults kept); every assertion is robust to an extra
 * tick because dedup keeps OPEN at ≤1 and the failure evidence is
 * written once.
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch + node:sqlite only, zero src imports.
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
}

/** Boot the real server against the given DB file (real startup path). */
async function bootServer(
  dir: string,
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<Booted> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault + project root (fail-closed without them).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
    ...extraEnv,
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

/** Stop the server and wait for the process to actually exit. */
async function stopServer(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
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

interface AuditRow {
  id: string;
  action: string;
}

/** "Attacker with DB access": rewrite a sealed middle record out-of-band. */
async function tamperMiddleRecord(port: number, dbFile: string): Promise<string> {
  const list = await api(port, 'GET', '/api/audit?limit=200');
  assert.equal(list.status, 200, 'GET /api/audit');
  const appendOrder = (list.body as Array<AuditRow>).slice().reverse();
  assert.ok(appendOrder.length >= 3, `expected ≥3 records, got ${appendOrder.length}`);
  const tamperIdx = Math.floor(appendOrder.length / 2);
  const tamperedId = appendOrder[tamperIdx].id;
  let tampered = false;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 10 && !tampered; attempt++) {
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare('UPDATE audit_logs SET details = ? WHERE id = ?').run(
        JSON.stringify({ tampered: true, note: 'watch walkthrough rewrote this record' }),
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
  return tamperedId;
}

interface NeedsHumanItem {
  id: string;
  reason: string;
  severity: string;
  source: string;
  status: string;
  requiredDeciderLevel: string;
  detailJson: string;
}

async function openUpgrades(port: number): Promise<NeedsHumanItem[]> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200, 'GET /api/needs-human?status=open');
  return (r.body['items'] as NeedsHumanItem[]) ?? [];
}

describe('Walkthrough: audit-chain watch leg (Batch 56, F36)', () => {
  it('A→B→C: boot silent, tamper raises one upgrade, opt-out disables the watch', { timeout: 240_000 }, async () => {
    // ---- A: healthy DB boot → the watch is silent. ----
    const dirA = mkdtempSync(join(tmpdir(), 'factory-watch-walk-'));
    const dbFileA = join(dirA, 'factory.db');
    let srv = await bootServer(dirA, dbFileA);
    for (const name of ['watch-walk-a', 'watch-walk-b', 'watch-walk-c']) {
      const r = await api(srv.port, 'POST', '/api/projects', { name });
      assert.equal(r.status, 201, `POST /api/projects ${name}`);
    }
    let open = await openUpgrades(srv.port);
    assert.equal(open.length, 0, `A: healthy boot must raise nothing, got ${open.length} OPEN`);

    // ---- B: tamper, reboot → boot check raises exactly one OPEN security-issue. ----
    // Tamper while the server is still up (the walkthrough reads the list
    // over HTTP), then stop and reboot the same DB.
    await tamperMiddleRecord(srv.port, dbFileA);
    await stopServer(srv.child);
    srv = await bootServer(dirA, dbFileA); // same DB, new port
    open = await openUpgrades(srv.port);
    assert.equal(open.length, 1, `B: broken chain must raise exactly 1 OPEN, got ${open.length}`);
    const rec = open[0];
    assert.equal(rec.reason, 'security-issue', 'B: §81 reason');
    assert.equal(rec.source, 'audit-chain-watch', 'B: watch source key');
    assert.equal(rec.severity, 'critical', 'B: security-issue severity');
    assert.equal(rec.requiredDeciderLevel, 'operator', 'B: operator-level decider');
    assert.equal(rec.status, 'open', 'B: upgrade is OPEN');
    // F19: the honest narrative must survive persistence in detailJson.
    const detail = JSON.parse(rec.detailJson) as { narrative: string };
    assert.ok(detail.narrative.includes('BROKEN'), 'B: narrative must say BROKEN');
    assert.ok(
      detail.narrative.includes('Human judgment needed'),
      'B: narrative must ask for human judgment',
    );
    assert.ok(
      detail.narrative.includes('append-order'),
      'B: narrative must state the brokenAt ordering',
    );
    assert.ok(
      !detail.narrative.includes('tampered'),
      'B: narrative must not contain the injected payload',
    );
    // The failure evidence is written once, not per tick/boot.
    const auditList = await api(srv.port, 'GET', '/api/audit?limit=200');
    const actions = (auditList.body as Array<AuditRow>).map((r) => r.action);
    assert.equal(
      actions.filter((a) => a === 'AUDIT_CHAIN_VERIFY_FAILED').length,
      1,
      'B: AUDIT_CHAIN_VERIFY_FAILED must be written exactly once',
    );
    assert.ok(actions.includes('NEEDS_HUMAN_RAISED'), 'B: NEEDS_HUMAN_RAISED must be audited');
    await stopServer(srv.child);

    // ---- B2: reboot again while still broken → still exactly 1 OPEN (no storm). ----
    srv = await bootServer(dirA, dbFileA);
    open = await openUpgrades(srv.port);
    assert.equal(open.length, 1, `B2: repeated boot checks must not storm, got ${open.length} OPEN`);
    const auditList2 = await api(srv.port, 'GET', '/api/audit?limit=200');
    const actions2 = (auditList2.body as Array<AuditRow>).map((r) => r.action);
    assert.equal(
      actions2.filter((a) => a === 'AUDIT_CHAIN_VERIFY_FAILED').length,
      1,
      'B2: failure evidence still written exactly once',
    );
    await stopServer(srv.child);

    // ---- C: same tamper, watch disabled → no check, no upgrade. ----
    const dirC = mkdtempSync(join(tmpdir(), 'factory-watch-walk-'));
    const dbFileC = join(dirC, 'factory.db');
    srv = await bootServer(dirC, dbFileC);
    for (const name of ['watch-walk-off-a', 'watch-walk-off-b', 'watch-walk-off-c']) {
      const r = await api(srv.port, 'POST', '/api/projects', { name });
      assert.equal(r.status, 201, `POST /api/projects ${name}`);
    }
    // Tamper while the server is still up, then stop and reboot with the watch off.
    await tamperMiddleRecord(srv.port, dbFileC);
    await stopServer(srv.child);
    srv = await bootServer(dirC, dbFileC, { FACTORY_AUDIT_CHAIN_WATCH: '0' });
    open = await openUpgrades(srv.port);
    assert.equal(open.length, 0, `C: disabled watch must raise nothing, got ${open.length} OPEN`);
    // Control: the chain really is broken — 0 OPEN is the opt-out, not a failed tamper.
    const verify = await api(srv.port, 'GET', '/api/audit/verify');
    assert.equal(verify.status, 200, 'GET /api/audit/verify');
    assert.equal(verify.body['ok'], false, 'C: control — chain is broken even with the watch off');
    await stopServer(srv.child);
  });
});
