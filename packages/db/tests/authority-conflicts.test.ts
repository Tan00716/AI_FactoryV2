/**
 * Durable authority-conflict registry rows — §8.1, Batch 75 (F12).
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - saveDirective / saveConflict are upserts keyed by id (register,
 *    supersede, override, attach and resolve all write through the
 *    same path — no duplicate error, the newest full row wins);
 *  - list returns deep copies (mutating a returned object never
 *    affects the store);
 *  - corrupt rows fail loudly (invalid enum value / unparseable JSON
 *    throws), never normalized;
 *  - rows survive a database reopen; both tables are created on old
 *    files (IF NOT EXISTS in SCHEMA).
 *
 * This file imports ../src/index directly (AGENTS.md package
 * convention — the store only value-imports node:sqlite, so
 * node type-stripping resolves it fine; @ai-factory/policy is
 * imported type-only).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuthorityConflict,
  Directive,
} from '@ai-factory/policy';
import {
  FactoryDatabase,
  InMemoryAuthorityConflictStore,
  SqliteAuthorityConflictStore,
  type AuthorityConflictStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-ac-'));
  return { dir, file: join(dir, 'factory.db') };
}

function makeDirective(id: string, status: Directive['status'] = 'ACTIVE'): Directive {
  return {
    directiveId: id,
    principalId: 'mgr-a',
    authorityLevel: 'manager',
    targetKind: 'run',
    targetId: 'run-1',
    effect: 'ALLOW',
    instruction: 'proceed',
    createdAt: '2026-10-15T00:00:00.000Z',
    status,
  };
}

function makeConflict(id: string, status: AuthorityConflict['status'] = 'OPEN'): AuthorityConflict {
  const c: AuthorityConflict = {
    conflictId: id,
    targetKind: 'run',
    targetId: 'run-1',
    status,
    directiveIds: ['dir-1', 'dir-2'],
    detectedAt: '2026-10-15T00:01:00.000Z',
  };
  if (status === 'RESOLVED') {
    c.resolution = {
      mode: 'human',
      decidedByPrincipalId: 'owner-1',
      winningDirectiveId: 'dir-1',
      rationale: 'owner picks ALLOW',
      resolvedAt: '2026-10-15T00:02:00.000Z',
    };
  }
  return c;
}

/** The same behavioral script runs against memory and SQLite (fresh store per case). */
function scriptAuthorityConflicts(fresh: () => AuthorityConflictStore, label: string): void {
  it(`${label}: saveDirective + list round-trip, field for field`, () => {
    const store = fresh();
    const d = makeDirective('dir-1');
    store.saveDirective(d);
    assert.deepEqual(store.listDirectives(), [d]);
  });

  it(`${label}: saveConflict OPEN + list round-trip, resolution undefined stays undefined`, () => {
    const store = fresh();
    const c = makeConflict('ac-1', 'OPEN');
    store.saveConflict(c);
    const back = store.listConflicts();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], c);
    assert.equal(back[0].resolution, undefined);
  });

  it(`${label}: re-saving the same directive id updates the row (no duplicate error)`, () => {
    const store = fresh();
    store.saveDirective(makeDirective('dir-u', 'ACTIVE'));
    store.saveDirective(makeDirective('dir-u', 'SUPERSEDED'));
    const list = store.listDirectives();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'SUPERSEDED');
  });

  it(`${label}: re-saving the same conflict id updates status + resolution`, () => {
    const store = fresh();
    store.saveConflict(makeConflict('ac-u', 'OPEN'));
    store.saveConflict(makeConflict('ac-u', 'RESOLVED'));
    const list = store.listConflicts();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'RESOLVED');
    assert.equal(list[0].resolution?.mode, 'human');
    assert.equal(list[0].resolution?.winningDirectiveId, 'dir-1');
  });

  it(`${label}: lists return deep copies`, () => {
    const store = fresh();
    store.saveDirective(makeDirective('dir-c'));
    store.saveConflict(makeConflict('ac-c'));
    const ds = store.listDirectives();
    ds[0].status = 'OVERRIDDEN';
    ds[0].principalId = 'hacker';
    const cs = store.listConflicts();
    cs[0].directiveIds.push('dir-evil');
    cs[0].status = 'RESOLVED';
    assert.equal(store.listDirectives()[0].status, 'ACTIVE');
    assert.equal(store.listDirectives()[0].principalId, 'mgr-a');
    assert.deepEqual(store.listConflicts()[0].directiveIds, ['dir-1', 'dir-2']);
    assert.equal(store.listConflicts()[0].status, 'OPEN');
  });

  it(`${label}: empty store lists empty`, () => {
    const store = fresh();
    assert.deepEqual(store.listDirectives(), []);
    assert.deepEqual(store.listConflicts(), []);
  });
}

describe('authority-conflict store parity (memory vs sqlite)', () => {
  scriptAuthorityConflicts(() => new InMemoryAuthorityConflictStore(), 'memory');

  // SQLite leg: one temp file for the block, a fresh connection (and
  // empty tables) per case, all connections closed in after().
  const { dir, file } = tmpDbFile();
  const open: DatabaseSync[] = [];
  after(() => {
    for (const c of open) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const DDL = `
    CREATE TABLE IF NOT EXISTS authority_directives (
      directive_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
      authority_level TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, effect TEXT NOT NULL,
      instruction TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS authority_conflicts (
      conflict_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, status TEXT NOT NULL,
      directive_ids_json TEXT NOT NULL, detected_at TEXT NOT NULL,
      resolution_json TEXT);`;
  scriptAuthorityConflicts(() => {
    const raw = new DatabaseSync(file);
    raw.exec(DDL);
    raw.exec('DELETE FROM authority_directives; DELETE FROM authority_conflicts;');
    open.push(raw);
    return new SqliteAuthorityConflictStore(raw);
  }, 'sqlite');
});

describe('authority-conflict store on real node:sqlite', () => {
  it('rows survive a database reopen', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      fdb.authorityConflicts.saveDirective(makeDirective('dir-re'));
      fdb.authorityConflicts.saveConflict(makeConflict('ac-re', 'RESOLVED'));
      fdb.close();
      const reopened = new FactoryDatabase(file);
      try {
        const ds = reopened.authorityConflicts.listDirectives();
        assert.equal(ds.length, 1);
        assert.deepEqual(ds[0], makeDirective('dir-re'));
        const cs = reopened.authorityConflicts.listConflicts();
        assert.equal(cs.length, 1);
        assert.deepEqual(cs[0], makeConflict('ac-re', 'RESOLVED'));
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('factory db: both tables are created on old files, rows survive reopen', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Simulate a pre-Batch-75 DB: full schema, then drop the new
      // tables — FactoryDatabase must recreate them on open (IF NOT EXISTS).
      const fdb0 = new FactoryDatabase(file);
      fdb0.close();
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE authority_directives; DROP TABLE authority_conflicts;');
      raw.close();
      const fdb = new FactoryDatabase(file);
      try {
        fdb.authorityConflicts.saveDirective(makeDirective('dir-mig'));
        fdb.authorityConflicts.saveConflict(makeConflict('ac-mig'));
        assert.equal(fdb.authorityConflicts.listDirectives().length, 1);
        assert.equal(fdb.authorityConflicts.listConflicts().length, 1);
      } finally {
        fdb.close();
      }
      const reopened = new FactoryDatabase(file);
      try {
        assert.deepEqual(reopened.authorityConflicts.listDirectives()[0], makeDirective('dir-mig'));
        assert.deepEqual(reopened.authorityConflicts.listConflicts()[0], makeConflict('ac-mig'));
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt directive row (bad status) fails loudly, never normalized', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const raw2 = new DatabaseSync(file);
        raw2
          .prepare(
            `INSERT INTO authority_directives
               (directive_id, principal_id, authority_level, target_kind, target_id,
                effect, instruction, created_at, status)
             VALUES ('dir-bad','p','manager','run','r1','ALLOW','x','t','BOGUS')`,
          )
          .run();
        raw2.close();
        assert.throws(() => fdb.authorityConflicts.listDirectives(), /corrupted/);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt conflict row (bad directive_ids_json) fails loudly', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const raw2 = new DatabaseSync(file);
        raw2
          .prepare(
            `INSERT INTO authority_conflicts
               (conflict_id, target_kind, target_id, status, directive_ids_json,
                detected_at, resolution_json)
             VALUES ('ac-bad','run','r1','OPEN','not-json','t',NULL)`,
          )
          .run();
        raw2.close();
        assert.throws(() => fdb.authorityConflicts.listConflicts(), SyntaxError);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
