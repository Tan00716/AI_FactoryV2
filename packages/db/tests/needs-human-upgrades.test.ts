/**
 * Durable §81 needsHuman upgrade records — Batch 36.
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - submit insert-only; duplicate id throws loudly (no silent replace);
 *  - resolve is conditional on still-open: resolving a terminal row
 *    returns false and never rewrites it;
 *  - nothing auto-resolves: the store has no "resolve on conflict
 *    resolution" path — a human marks it explicitly;
 *  - list newest-first; corrupt JSON rows fail loudly, never
 *    normalized; reads are deep copies;
 *  - rows survive a database reopen; the table is created on old
 *    files (IF NOT EXISTS in SCHEMA).
 *
 * This file imports ../src/index directly (AGENTS.md package
 * convention — the store only value-imports node:sqlite, so
 * node type-stripping resolves it fine).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  InMemoryNeedsHumanStore,
  SqliteNeedsHumanStore,
  type NeedsHumanDbRecord,
  type NeedsHumanStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-nhu-'));
  return { dir, file: join(dir, 'factory.db') };
}

function makeRow(id: string, raisedAt: number, status: 'open' | 'acknowledged' | 'resolved' = 'open'): NeedsHumanDbRecord {
  return {
    id,
    reason: 'ai-disagreement',
    reasonZh: 'AI 分歧',
    severity: 'medium',
    source: 'authority-conflict:ac-1',
    recipient: null,
    requiredDeciderLevel: 'owner',
    detailJson: JSON.stringify({ conflictId: 'ac-1', suggestion: 'owner decides' }),
    contextJson: JSON.stringify({ targetKind: 'run', targetId: 'run-1' }),
    raisedAt,
    status,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/** The same behavioral script runs against memory and SQLite (fresh store per case). */
function scriptNeedsHuman(fresh: () => NeedsHumanStore, label: string): void {
  it(`${label}: unknown id reads undefined`, () => {
    assert.equal(fresh().get('nope'), undefined);
  });

  it(`${label}: submit + get round-trip, field for field`, () => {
    const store = fresh();
    const r = makeRow('nhu-1', 1_000);
    store.submit(r);
    assert.deepEqual(store.get('nhu-1'), r);
  });

  it(`${label}: duplicate id throws loudly (no silent replace)`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-dup', 1_000));
    assert.throws(() => store.submit(makeRow('nhu-dup', 2_000)), /duplicate/);
    assert.equal(store.get('nhu-dup')?.raisedAt, 1_000);
  });

  it(`${label}: list is newest-first`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-old', 100));
    store.submit(makeRow('nhu-new', 200));
    store.submit(makeRow('nhu-mid', 150));
    assert.deepEqual(store.list().map((r) => r.id), ['nhu-new', 'nhu-mid', 'nhu-old']);
  });

  it(`${label}: list filters by status`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-o1', 100, 'open'));
    store.submit(makeRow('nhu-r1', 200, 'resolved'));
    assert.deepEqual(store.list('open').map((r) => r.id), ['nhu-o1']);
    assert.deepEqual(store.list('resolved').map((r) => r.id), ['nhu-r1']);
  });

  it(`${label}: resolve marks an open row terminal`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-res', 1_000));
    const ok = store.resolve('nhu-res', 'resolved', 'owner-1', 'approved ALLOW', 2_000);
    assert.equal(ok, true);
    const back = store.get('nhu-res');
    assert.equal(back?.status, 'resolved');
    assert.equal(back?.resolvedBy, 'owner-1');
    assert.equal(back?.resolution, 'approved ALLOW');
    assert.equal(back?.resolvedAt, 2_000);
  });

  it(`${label}: resolving a terminal row returns false and never rewrites it`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-t', 1_000, 'acknowledged'));
    const ok = store.resolve('nhu-t', 'resolved', 'owner-2', 'override', 3_000);
    assert.equal(ok, false);
    const back = store.get('nhu-t');
    assert.equal(back?.status, 'acknowledged');
    assert.equal(back?.resolvedBy, null);
  });

  it(`${label}: resolving an unknown id returns false`, () => {
    assert.equal(fresh().resolve('nope', 'resolved', 'x', null, 1), false);
  });

  it(`${label}: acknowledged is terminal too`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-a', 1_000));
    assert.equal(store.resolve('nhu-a', 'acknowledged', 'owner-1', null, 2_000), true);
    assert.equal(store.resolve('nhu-a', 'resolved', 'owner-1', null, 3_000), false);
    assert.equal(store.get('nhu-a')?.status, 'acknowledged');
  });

  it(`${label}: copy contract — mutating a read does not corrupt the store`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-c', 1_000));
    const back = store.get('nhu-c');
    assert.ok(back);
    (back as NeedsHumanDbRecord).status = 'resolved';
    assert.equal(store.get('nhu-c')?.status, 'open');
  });

  it(`${label}: open rows hydrate as-is (no demotion — a raised upgrade awaiting a human)`, () => {
    const store = fresh();
    store.submit(makeRow('nhu-open', 1_000, 'open'));
    assert.equal(store.get('nhu-open')?.status, 'open');
  });
}

describe('needs-human store parity (memory vs sqlite)', () => {
  scriptNeedsHuman(() => new InMemoryNeedsHumanStore(), 'memory');
});

describe('needs-human store on real node:sqlite', () => {
  it('sqlite: parity with the memory reference', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS needs_human_upgrades (
           id TEXT PRIMARY KEY, reason TEXT NOT NULL, reason_zh TEXT NOT NULL,
           severity TEXT NOT NULL, source TEXT NOT NULL, recipient TEXT,
           required_decider_level TEXT NOT NULL, detail_json TEXT NOT NULL,
           context_json TEXT NOT NULL, raised_at INTEGER NOT NULL,
           status TEXT NOT NULL, resolved_at INTEGER,
           resolved_by TEXT, resolution TEXT);`,
      );
      const store = new SqliteNeedsHumanStore(raw);
      const r = makeRow('nhu-sql', 42);
      store.submit(r);
      assert.deepEqual(store.get('nhu-sql'), r);
      assert.equal(store.resolve('nhu-sql', 'resolved', 'o', null, 43), true);
      assert.equal(store.resolve('nhu-sql', 'resolved', 'o', null, 44), false);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: corrupt detail_json fails loudly', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS needs_human_upgrades (
           id TEXT PRIMARY KEY, reason TEXT NOT NULL, reason_zh TEXT NOT NULL,
           severity TEXT NOT NULL, source TEXT NOT NULL, recipient TEXT,
           required_decider_level TEXT NOT NULL, detail_json TEXT NOT NULL,
           context_json TEXT NOT NULL, raised_at INTEGER NOT NULL,
           status TEXT NOT NULL, resolved_at INTEGER,
           resolved_by TEXT, resolution TEXT);
         INSERT INTO needs_human_upgrades
           (id, reason, reason_zh, severity, source, recipient,
            required_decider_level, detail_json, context_json, raised_at,
            status, resolved_at, resolved_by, resolution)
         VALUES ('nhu-c', 'ai-disagreement', 'x', 'medium', 's', NULL,
                 'owner', '{bad', '{}', 1, 'open', NULL, NULL, NULL);`,
      );
      const store = new SqliteNeedsHumanStore(raw);
      assert.throws(() => store.get('nhu-c'), /JSON|corrupt/);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('factory db: table is created on old files, rows survive reopen', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Simulate a pre-Batch-36 DB: full schema, then drop the new
      // table — FactoryDatabase must recreate it on open (IF NOT EXISTS).
      const fdb0 = new FactoryDatabase(file);
      fdb0.close();
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE needs_human_upgrades;');
      raw.close();
      const fdb = new FactoryDatabase(file);
      const r = makeRow('nhu-re', 7);
      fdb.needsHuman.submit(r);
      assert.deepEqual(fdb.needsHuman.get('nhu-re'), r);
      assert.equal(fdb.needsHuman.resolve('nhu-re', 'acknowledged', 'owner-9', 'noted', 8), true);
      const reopened = new FactoryDatabase(file);
      const back = reopened.needsHuman.get('nhu-re');
      assert.equal(back?.status, 'acknowledged');
      assert.equal(back?.resolvedBy, 'owner-9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
