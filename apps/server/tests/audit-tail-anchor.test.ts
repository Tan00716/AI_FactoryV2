/**
 * Audit-chain tail anchoring (W-C P2 follow-up) — unit + e2e tests.
 *
 * The §32 hash chain verifies forward from genesis, so deleting TAIL
 * records is invisible to it. The tail anchor (apps/server/src/
 * audit-tail-anchor.ts) persists a watermark {maxChainedCount, headHash}
 * after each successful verify and reports TAIL_TRUNCATED when the chain
 * shrinks or its head is rewritten.
 *
 * Part A: pure unit tests over InMemoryAuditStore (DroppableStore adds a
 * test-only tail-drop, simulating the "attacker with DB access" — there
 * is deliberately no delete API on the store).
 * Part B: end-to-end over HTTP against the real built server
 * (../dist/index.js): tail rows deleted via a second node:sqlite
 * connection, anchor file corrupted on disk.
 * Part C: the periodic watch raises a §81 upgrade on tail truncation.
 *
 * Hermetic: temp dirs for the anchor file / DB / secrets; the unit part
 * never touches the network. Dual-mode: the src module is imported with
 * an explicit `.ts` suffix — its own value imports are node builtins +
 * compiled @ai-factory/* dists only (root build must run first).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AuditLog, InMemoryAuditStore } from '@ai-factory/core';
import {
  FileAuditTailAnchorStore,
  auditTailAnchorPathForDb,
  verifyAuditChainWithTailAnchor,
} from '../src/audit-tail-anchor.ts';
import {
  buildAuditChainBreakRecord,
  tickAuditChainWatch,
} from '../src/audit-chain-watch.ts';

const tmpRoots: string[] = [];
after(() => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** Test-only store: tail-drop simulates an out-of-band DB writer. */
class DroppableStore extends InMemoryAuditStore {
  dropLast(n: number): void {
    const recs = (this as unknown as { records: unknown[] }).records;
    recs.splice(Math.max(0, recs.length - n), n);
  }
  tamperAt(index: number): void {
    const recs = (this as unknown as { records: Array<{ details: unknown }> }).records;
    recs[index].details = { tampered: true };
  }
}

function makeUnitWorld() {
  const dir = mkTemp('factory-tail-anchor-unit-');
  const anchorFile = join(dir, 'anchor.json');
  const store = new DroppableStore();
  const audit = new AuditLog(store);
  const anchor = new FileAuditTailAnchorStore(anchorFile);
  return { dir, anchorFile, store, audit, anchor };
}

function seed(audit: AuditLog, n: number, prefix = 'TAIL'): void {
  for (let i = 0; i < n; i++) {
    audit.record('test', `${prefix}_${i}`, 'test', `e-${i}`, { i });
  }
}

function readAnchorJson(anchorFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(anchorFile, 'utf8')) as Record<string, unknown>;
}

// ------------------------------------------------------------------ Part A

describe('tail anchor — unit', () => {
  it('bootstrap: missing anchor → ok + initialized, anchor file written', () => {
    const w = makeUnitWorld();
    seed(w.audit, 3);
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, true);
    assert.equal(v.tailTruncated, false);
    assert.equal(v.tailAnchorStatus, 'initialized');
    assert.ok(!('code' in v), `no code on healthy bootstrap, got ${JSON.stringify(v)}`);
    const persisted = readAnchorJson(w.anchorFile);
    assert.equal(persisted['maxChainedCount'], 3);
    assert.ok(typeof persisted['headHash'] === 'string' && persisted['headHash'] !== '');
    // Second verify: steady state.
    const v2 = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v2.ok, true);
    assert.equal(v2.tailAnchorStatus, 'ok');
  });

  it('healthy growth ratchets the anchor forward (never down)', () => {
    const w = makeUnitWorld();
    seed(w.audit, 3);
    verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    seed(w.audit, 2);
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, true);
    assert.equal(v.tailTruncated, false);
    assert.equal(readAnchorJson(w.anchorFile)['maxChainedCount'], 5);
  });

  it('tail deletion → ok:false TAIL_TRUNCATED with expected/observed counts', () => {
    const w = makeUnitWorld();
    seed(w.audit, 5);
    verifyAuditChainWithTailAnchor(w.audit, w.anchor); // anchor: 5
    w.store.dropLast(2); // "attacker with DB access" deletes the tail
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, false, 'truncated tail must NOT verify');
    assert.equal(v.tailTruncated, true);
    assert.equal(v.code, 'AUDIT_TAIL_TRUNCATED');
    assert.equal(v.expectedChainedCount, 5);
    assert.equal(v.observedChainedCount, 3);
    assert.ok(!('brokenAt' in v), 'forward links are intact — no brokenAt');
    // The anchor never ratchets down: a later verify still reports 5 vs 3.
    assert.equal(readAnchorJson(w.anchorFile)['maxChainedCount'], 5);
    const v2 = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v2.ok, false);
    assert.equal(v2.code, 'AUDIT_TAIL_TRUNCATED');
  });

  it('tail rewrite (same count, new head) → TAIL_TRUNCATED', () => {
    const w = makeUnitWorld();
    seed(w.audit, 5);
    verifyAuditChainWithTailAnchor(w.audit, w.anchor); // anchor: 5, head H5
    w.store.dropLast(1);
    seed(w.audit, 1, 'REWRITTEN'); // count back to 5, but a different head
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, false, 'rewritten tail must NOT verify');
    assert.equal(v.tailTruncated, true);
    assert.equal(v.code, 'AUDIT_TAIL_TRUNCATED');
    assert.equal(v.expectedChainedCount, 5);
    assert.equal(v.observedChainedCount, 5);
  });

  it('corrupt anchor → fail-closed AUDIT_TAIL_ANCHOR_UNREADABLE', () => {
    const w = makeUnitWorld();
    seed(w.audit, 3);
    verifyAuditChainWithTailAnchor(w.audit, w.anchor); // anchor written
    // The chain itself is intact — the failure must come from the anchor.
    assert.equal(w.audit.verify().ok, true, 'precondition: forward chain intact');
    writeFileSync(w.anchorFile, 'this is not json {{{', 'utf8');
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, false, 'corrupt anchor must fail closed');
    assert.equal(v.tailTruncated, false);
    assert.equal(v.tailAnchorStatus, 'unreadable');
    assert.equal(v.code, 'AUDIT_TAIL_ANCHOR_UNREADABLE');

    writeFileSync(w.anchorFile, JSON.stringify({ maxChainedCount: -1 }), 'utf8');
    const v2 = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v2.ok, false);
    assert.equal(v2.code, 'AUDIT_TAIL_ANCHOR_UNREADABLE');
  });

  it('anchor write failure → fail-closed AUDIT_TAIL_ANCHOR_WRITE_FAILED', () => {
    const w = makeUnitWorld();
    seed(w.audit, 2);
    const failingStore = {
      read: () => null,
      write: () => {
        throw new Error('disk full (simulated)');
      },
    };
    const v = verifyAuditChainWithTailAnchor(w.audit, failingStore);
    assert.equal(v.ok, false, 'unpersistable anchor must fail closed');
    assert.equal(v.tailAnchorStatus, 'write-failed');
    assert.equal(v.code, 'AUDIT_TAIL_ANCHOR_WRITE_FAILED');
  });

  it('middle tamper still reports brokenAt (forward check unaffected)', () => {
    const w = makeUnitWorld();
    seed(w.audit, 5);
    verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    w.store.tamperAt(2);
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
    assert.equal(v.tailTruncated, false);
    assert.ok(!('code' in v), 'forward breaks keep the legacy shape (no tail code)');
    // A broken chain is never blessed: the anchor still says 5.
    assert.equal(readAnchorJson(w.anchorFile)['maxChainedCount'], 5);
  });

  it('legacy tail record deletion is not flagged (documented boundary)', () => {
    const w = makeUnitWorld();
    seed(w.audit, 3);
    // A pre-chaining row: no hash fields, appended straight to the store.
    w.store.append({
      id: 'legacy-1',
      ts: new Date().toISOString(),
      actor: 'test',
      action: 'LEGACY',
      entityType: 'test',
      entityId: 'legacy-1',
      details: {},
    } as never);
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, true);
    assert.equal(v.legacyCount, 1);
    assert.equal(readAnchorJson(w.anchorFile)['maxChainedCount'], 3);
    w.store.dropLast(1); // delete the trailing legacy record
    const v2 = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v2.ok, true, 'legacy records are unverified by design — no promise broken');
  });

  it('empty chain bootstraps cleanly (headHash empty, count 0)', () => {
    const w = makeUnitWorld();
    const v = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v.ok, true);
    assert.equal(v.tailAnchorStatus, 'initialized');
    assert.equal(readAnchorJson(w.anchorFile)['maxChainedCount'], 0);
    seed(w.audit, 1);
    const v2 = verifyAuditChainWithTailAnchor(w.audit, w.anchor);
    assert.equal(v2.ok, true);
    assert.equal(v2.tailAnchorStatus, 'ok');
  });
});

// ------------------------------------------------------------------ Part B

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));
const children: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  child: ChildProcess;
  port: number;
  dbFile: string;
  anchorFile: string;
}

async function bootServer(): Promise<Booted> {
  const dir = mkTemp('factory-tail-anchor-e2e-');
  const dbFile = join(dir, 'factory.db');
  const anchorFile = join(dir, 'anchor.json');
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE: anchorFile,
    // The periodic watch would append audit rows on raise and skew the
    // counts under test; the boot tick is deterministic enough without it.
    FACTORY_AUDIT_CHAIN_WATCH: '0',
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port, dbFile, anchorFile };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in 20000ms');
    await sleep(150);
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
  return { status: res.status, body: (await res.json()) as Json };
}

async function makeRecords(port: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await api(port, 'POST', '/api/projects', { name: `tail-anchor-p${i}` });
    assert.equal(r.status, 201, `POST /api/projects tail-anchor-p${i}`);
  }
}

/** Newest-first bare array (F21) → tail ids are the first entries. */
async function tailIds(port: number, n: number): Promise<string[]> {
  const r = await api(port, 'GET', '/api/audit?limit=200');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  return (r.body as Array<Json & { id: string }>).slice(0, n).map((x) => x.id);
}

/** "Attacker with DB access": second node:sqlite connection, like Batch 52. */
async function deleteRows(dbFile: string, ids: string[]): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare(`DELETE FROM audit_logs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(200);
    } finally {
      db.close();
    }
  }
  throw new Error(`direct DB delete failed: ${String(lastErr)}`);
}

describe('tail anchor — e2e over HTTP', () => {
  it('intact chain → ok:true, tailTruncated:false (bootstrap then steady)', { timeout: 60_000 }, async () => {
    const { port } = await bootServer();
    await makeRecords(port, 3);
    const first = await api(port, 'GET', '/api/audit/verify');
    assert.equal(first.status, 200);
    assert.equal(first.body['ok'], true);
    assert.equal(first.body['tailTruncated'], false);
    assert.equal(first.body['tailAnchorStatus'], 'initialized', 'first verify bootstraps the anchor');
    const second = await api(port, 'GET', '/api/audit/verify');
    assert.equal(second.body['ok'], true);
    assert.equal(second.body['tailAnchorStatus'], 'ok');
    assert.ok(!('brokenAt' in second.body), 'no brokenAt when ok');
  });

  it('tail rows deleted via direct DB → ok:false AUDIT_TAIL_TRUNCATED', { timeout: 60_000 }, async () => {
    const { port, dbFile } = await bootServer();
    await makeRecords(port, 3);
    const before = await api(port, 'GET', '/api/audit/verify');
    assert.equal(before.body['ok'], true);
    const anchored = before.body['verifiedCount'] as number;
    assert.ok(anchored >= 3, `expected ≥3 chained records, got ${anchored}`);

    await deleteRows(dbFile, await tailIds(port, 2));
    const r = await api(port, 'GET', '/api/audit/verify');
    assert.equal(r.status, 200);
    assert.equal(r.body['ok'], false, 'truncated tail must NOT verify');
    assert.equal(r.body['tailTruncated'], true);
    assert.equal(r.body['code'], 'AUDIT_TAIL_TRUNCATED');
    assert.equal(r.body['expectedChainedCount'], anchored);
    assert.equal(r.body['observedChainedCount'], anchored - 2);
  });

  it('corrupt anchor file → ok:false AUDIT_TAIL_ANCHOR_UNREADABLE (fail-closed)', { timeout: 60_000 }, async () => {
    const { port, anchorFile } = await bootServer();
    await makeRecords(port, 2);
    const before = await api(port, 'GET', '/api/audit/verify');
    assert.equal(before.body['ok'], true, 'precondition: chain verifies before corruption');
    writeFileSync(anchorFile, '{{{ not json', 'utf8');
    const r = await api(port, 'GET', '/api/audit/verify');
    assert.equal(r.status, 200);
    assert.equal(r.body['ok'], false, 'corrupt anchor must fail closed');
    assert.equal(r.body['code'], 'AUDIT_TAIL_ANCHOR_UNREADABLE');
    assert.equal(r.body['tailAnchorStatus'], 'unreadable');
  });
});

// ------------------------------------------------------------------ Part C

describe('anchor path colocation with the DB', () => {
  it('resolves next to the database file, not CWD', () => {
    const p = auditTailAnchorPathForDb(join('/tmp', 'some-db-dir', 'factory.db'));
    assert.equal(p, join('/tmp', 'some-db-dir', 'audit-tail-anchor.json'));
  });

  it('explicit AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE still wins', () => {
    const saved = process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE;
    process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE = join('/tmp', 'custom-anchor.json');
    try {
      assert.equal(
        auditTailAnchorPathForDb(join('/tmp', 'other', 'factory.db')),
        join('/tmp', 'custom-anchor.json'),
      );
    } finally {
      if (saved === undefined) delete process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE;
      else process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE = saved;
    }
  });
});

describe('watch raises on tail truncation', () => {
  it('tick → raised with the truncation narrative and counts', () => {
    const dir = mkTemp('factory-tail-anchor-watch-');
    const store = new DroppableStore();
    const audit = new AuditLog(store);
    const anchor = new FileAuditTailAnchorStore(join(dir, 'anchor.json'));
    const submitted: Array<{ status: string; detailJson: string }> = [];
    const deps = {
      needsHuman: {
        submit: (r: { status: string; detailJson: string }) => {
          submitted.push(r);
        },
        list: () => submitted.filter((r) => r.status === 'open'),
      },
      audit: {
        record: (...args: Parameters<AuditLog['record']>) => audit.record(...args),
        verify: () => verifyAuditChainWithTailAnchor(audit, anchor),
      },
    };
    seed(audit, 4);
    assert.equal(tickAuditChainWatch(deps), 'ok');
    store.dropLast(2);
    assert.equal(tickAuditChainWatch(deps), 'raised');
    assert.equal(submitted.length, 1);
    const detail = JSON.parse(submitted[0].detailJson) as Record<string, unknown>;
    assert.equal(detail['tailTruncated'], true);
    assert.equal(detail['code'], 'AUDIT_TAIL_TRUNCATED');
    assert.equal(detail['expectedChainedCount'], 4);
    assert.equal(detail['observedChainedCount'], 2);
    assert.match(String(detail['narrative']), /TAIL-TRUNCATED/);
  });

  it('buildAuditChainBreakRecord tail narrative mentions restore re-baselining', () => {
    const rec = buildAuditChainBreakRecord({
      brokenAt: -1,
      verifiedCount: 3,
      legacyCount: 0,
      tailTruncated: true,
      code: 'AUDIT_TAIL_TRUNCATED',
      expectedChainedCount: 5,
      observedChainedCount: 3,
    });
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.match(String(detail['narrative']), /re-baseline/);
    assert.match(String(rec.detailJson), /restore/);
  });
});
