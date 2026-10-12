/**
 * Denied step intents in SQLite — SPEC v2 §28.1 (Batch 12 follow-up).
 *
 * Since Batch 12-4 the harness persists the intent BEFORE the permission
 * gate and commits a denial payload ({ ok:false, denied:true, reason })
 * through recordResult when the gate refuses the call. The runtime's
 * in-memory store labels that commit DENIED; this file pins the SQLite
 * store to the same label and the same result-hash commitment, so the
 * server path (which runs on this store) reconciles identically:
 * DENIED is a decided terminal state — never PENDING (the startup scan
 * must not report it as interrupted) and never EXECUTED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  StepIntentStore,
  isStepIntentDenial,
} from '@ai-factory/runtime';
import { SCHEMA, SqliteStepIntentStore } from '../src/index';

function sqliteStore(): SqliteStepIntentStore {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  return new SqliteStepIntentStore(sqlite);
}

describe('SqliteStepIntentStore denial commits (§28.1)', () => {
  it('recordDenied lands DENIED with the same hash commitment as the in-memory store', () => {
    const mem = new StepIntentStore();
    const sql = sqliteStore();

    const a = mem.persistIntent('run-1', 'deploy', { x: 1 });
    const b = sql.persistIntent('run-1', 'deploy', { x: 1 });
    // Ids/timestamps are store-local; align on the content fields.
    const memDenied = mem.recordDenied(a.id, 'permission denied: deploy');
    const sqlDenied = sql.recordDenied(b.id, 'permission denied: deploy');

    assert.equal(sqlDenied.status, 'DENIED');
    assert.equal(sqlDenied.resultHash, memDenied.resultHash);
    assert.ok(isStepIntentDenial(JSON.parse('{"ok":false,"denied":true,"reason":"permission denied: deploy"}')));

    // Decided, not interrupted: pending is empty on both stores.
    assert.equal(sql.pendingIntents().length, 0);
    assert.equal(mem.pendingIntents().length, 0);
    // …but the attempt stays on the record for reconciliation.
    const listed = sql.listIntents();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'DENIED');
    assert.equal(listed[0].tool, 'deploy');
  });

  it('a plain failure payload still lands FAILED; ok still lands EXECUTED', () => {
    const sql = sqliteStore();
    const f = sql.persistIntent('run-2', 'echo', {});
    assert.equal(sql.recordResult(f.id, false, { error: 'boom' }).status, 'FAILED');
    const e = sql.persistIntent('run-2', 'echo', {});
    assert.equal(sql.recordResult(e.id, true, 'done').status, 'EXECUTED');
  });
});
