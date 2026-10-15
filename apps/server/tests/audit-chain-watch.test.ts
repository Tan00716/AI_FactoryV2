/**
 * Audit-chain watch (Batch 55, F36): periodic §32 self-check.
 *
 * Hermetic: temp DB per test, temp everything, no server boot — the
 * watch is pure in-process logic over a real SQLite-backed
 * FactoryDatabase + AuditLog. Dual-mode: the src module is imported
 * with an explicit `.ts` suffix and its own relative imports are
 * type-only (packages are compiled dists; root build must run first).
 *
 * Tampering mirrors the Batch 52/53 walkthroughs: a second
 * `node:sqlite` connection (the "attacker with DB access") UPDATEs a
 * sealed record. There is deliberately no HTTP tamper path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDatabase } from '@ai-factory/db';
import { AuditLog } from '@ai-factory/core';
import {
  AUDIT_CHAIN_WATCH_SOURCE,
  buildAuditChainBreakRecord,
  parseAuditChainWatchIntervalMs,
  tickAuditChainWatch,
} from '../src/audit-chain-watch.ts';
import type { AuditChainWatchDeps } from '../src/audit-chain-watch.ts';

interface World {
  dir: string;
  dbFile: string;
  fdb: FactoryDatabase;
  audit: AuditLog;
  deps: AuditChainWatchDeps;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'factory-watch-'));
  const dbFile = join(dir, 'factory.db');
  const fdb = new FactoryDatabase(dbFile);
  const audit = new AuditLog(fdb.audit);
  return { dir, dbFile, fdb, audit, deps: { needsHuman: fdb.needsHuman, audit } };
}

function closeWorld(w: World): void {
  w.fdb.close();
  rmSync(w.dir, { recursive: true, force: true });
}

function seedEvents(audit: AuditLog, n: number): void {
  for (let i = 0; i < n; i++) {
    audit.record('test', `WATCH_SEED_${i}`, 'test', `seed-${i}`, { i });
  }
}

/** "Attacker with DB access": rewrite a sealed record out-of-band. */
function tamperMiddleRecord(dbFile: string, audit: AuditLog): void {
  const rows = audit.list();
  assert.ok(rows.length >= 3, 'need ≥3 records to tamper the middle one');
  const mid = rows[Math.floor(rows.length / 2)];
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare('UPDATE audit_logs SET details = ? WHERE id = ?').run(
      JSON.stringify({ tampered: true }),
      mid.id,
    );
  } finally {
    db.close();
  }
}

function auditActions(audit: AuditLog): string[] {
  return audit.list().map((r) => r.action);
}

describe('audit-chain watch', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });
  afterEach(() => {
    closeWorld(w);
  });

  it('healthy chain: tick is silent (ok, no upgrade, no failure audit)', () => {
    seedEvents(w.audit, 3);
    const result = tickAuditChainWatch(w.deps);
    assert.equal(result, 'ok');
    assert.equal(w.deps.needsHuman.list('open').length, 0);
    assert.ok(
      !auditActions(w.audit).includes('AUDIT_CHAIN_VERIFY_FAILED'),
      'a healthy tick must not audit anything',
    );
  });

  it('broken chain: raises exactly one OPEN security-issue with honest narrative', () => {
    seedEvents(w.audit, 3);
    tamperMiddleRecord(w.dbFile, w.audit);
    const result = tickAuditChainWatch(w.deps);
    assert.equal(result, 'raised');

    const open = w.deps.needsHuman.list('open');
    assert.equal(open.length, 1);
    const rec = open[0];
    assert.equal(rec.reason, 'security-issue');
    assert.equal(rec.source, AUDIT_CHAIN_WATCH_SOURCE);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.status, 'open');
    // F19: the honest narrative must survive persistence in detailJson.
    const detail = JSON.parse(rec.detailJson) as { narrative: string };
    assert.ok(detail.narrative.includes('BROKEN'), 'narrative must say BROKEN');
    assert.ok(
      detail.narrative.includes('Human judgment needed'),
      'narrative must ask for human judgment',
    );
    assert.ok(
      detail.narrative.includes('append-order'),
      'narrative must state the brokenAt ordering',
    );
    assert.ok(
      !detail.narrative.includes('tampered'),
      'narrative must not contain the injected payload',
    );

    const actions = auditActions(w.audit);
    assert.ok(actions.includes('AUDIT_CHAIN_VERIFY_FAILED'));
    assert.ok(actions.includes('NEEDS_HUMAN_RAISED'));
    const failEvent = w.audit
      .list()
      .find((r) => r.action === 'AUDIT_CHAIN_VERIFY_FAILED');
    assert.ok(failEvent);
    assert.equal(typeof (failEvent.details as { brokenAt: unknown }).brokenAt, 'number');
  });

  it('no storm: a second tick while still broken does not re-raise', () => {
    seedEvents(w.audit, 3);
    tamperMiddleRecord(w.dbFile, w.audit);
    assert.equal(tickAuditChainWatch(w.deps), 'raised');
    assert.equal(tickAuditChainWatch(w.deps), 'already-open');
    assert.equal(w.deps.needsHuman.list('open').length, 1);
    const failCount = auditActions(w.audit).filter(
      (a) => a === 'AUDIT_CHAIN_VERIFY_FAILED',
    ).length;
    assert.equal(failCount, 1, 'the failure evidence is written once, not per tick');
  });

  it('resolved-then-still-broken: re-raises on the next tick (list(open) is the authority)', () => {
    seedEvents(w.audit, 3);
    tamperMiddleRecord(w.dbFile, w.audit);
    assert.equal(tickAuditChainWatch(w.deps), 'raised');
    const first = w.deps.needsHuman.list('open')[0];
    assert.ok(
      w.fdb.needsHuman.resolve(first.id, 'resolved', null, 'chain restored', Date.now()),
    );
    assert.equal(tickAuditChainWatch(w.deps), 'raised');
    const open = w.deps.needsHuman.list('open');
    assert.equal(open.length, 1);
    assert.notEqual(open[0].id, first.id, 'a fresh record is raised after resolution');
  });

  it('buildAuditChainBreakRecord: pure builder with persisted narrative', () => {
    const rec = buildAuditChainBreakRecord({
      brokenAt: 7,
      verifiedCount: 7,
      legacyCount: 0,
    });
    assert.equal(rec.reason, 'security-issue');
    assert.equal(rec.source, AUDIT_CHAIN_WATCH_SOURCE);
    assert.equal(rec.status, 'open');
    assert.equal(rec.recipient, null);
    const detail = JSON.parse(rec.detailJson) as {
      narrative: string;
      brokenAt: number;
    };
    assert.ok(detail.narrative.includes('index 7'));
    assert.equal(detail.brokenAt, 7);
  });

  it('parseAuditChainWatchIntervalMs: invalid values fall back to default (fail-closed)', () => {
    assert.equal(parseAuditChainWatchIntervalMs(undefined), 60_000);
    assert.equal(parseAuditChainWatchIntervalMs('0'), 60_000);
    assert.equal(parseAuditChainWatchIntervalMs('-5'), 60_000);
    assert.equal(parseAuditChainWatchIntervalMs('abc'), 60_000);
    assert.equal(parseAuditChainWatchIntervalMs('30000'), 30_000);
    assert.equal(parseAuditChainWatchIntervalMs('1500.9'), 1500);
  });
});
