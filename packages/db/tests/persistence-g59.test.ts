/**
 * Durable runtime state — SPEC v2 §28.1/§32 (G-59, Batch 9).
 *
 * Pins the SQLite side of two contracts:
 *
 *  Audit (§32): SqliteAuditStore persists the hash-chain fields
 *  (reason / result / summary_hash / prev_hash) alongside the §70
 *  columns, so a chain written by one process verifies after a restart
 *  and keeps extending from the persisted head. Pre-chain databases are
 *  migrated in place; their rows read back as legacy records (chain
 *  fields absent), never backfilled.
 *
 *  Step intents (§28.1): SqliteStepIntentStore keeps the runtime
 *  StepIntentStore contract on the step_intents table — same shape,
 *  same hashing, same INTENT_NOT_FOUND failure — across instances.
 *  Intents a process left PENDING are what the next boot's startup scan
 *  must find via listInterrupted(), and the scan must not mutate them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, verifyAuditChain } from '@ai-factory/core';
import { FactoryError, StepIntentStore } from '@ai-factory/runtime';
import { FactoryDatabase, SqliteStepIntentStore } from '../src/index';

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = { now: () => FIXED_NOW };

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-g59-'));
  return { dir, file: join(dir, 'factory.db') };
}

describe('audit hash-chain persistence (§32)', () => {
  it('round-trips reason/result/hashes across a reopen; the chain survives and extends', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      const log1 = new AuditLog(fdb1.audit);
      log1.record('human', 'TASK_CREATED', 'task', 't1', { title: 'x' }, {
        reason: 'kickoff',
        result: 'SUCCEEDED',
      });
      log1.record('agent-1', 'TOOL_EXECUTED', 'task', 't1', { tool: 'echo' });
      log1.record('system', 'STARTUP_INTERRUPTED_INTENTS', 'step_intent', 'startup-scan', { count: 0 }, {
        result: 'NONE',
      });
      const before = log1.list();
      assert.equal(before.length, 3);
      assert.equal(before[0].reason, 'kickoff');
      assert.ok(before.every((r) => typeof r.summaryHash === 'string' && typeof r.prevHash === 'string'));
      fdb1.close();

      // A new process over the same file: the chain must verify as-is.
      const fdb2 = new FactoryDatabase(file);
      try {
        const log2 = new AuditLog(fdb2.audit);
        const after = log2.list();
        assert.deepEqual(after, before);
        assert.deepEqual(log2.verify(), { ok: true, verifiedCount: 3, legacyCount: 0 });
        assert.deepEqual(verifyAuditChain(after), { ok: true, verifiedCount: 3, legacyCount: 0 });

        // …and the next record links to the persisted head, not genesis.
        const r4 = log2.record('human', 'TASK_COMPLETED', 'task', 't1', {});
        assert.equal(r4.prevHash, before[2].summaryHash);
        assert.deepEqual(log2.verify(), { ok: true, verifiedCount: 4, legacyCount: 0 });
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a pre-chain database in place; legacy rows read back field-less and stay legacy', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Build a database with the OLD audit_logs table (7 columns) and
      // one legacy row, as any pre-Batch-9 local install would have.
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
          action TEXT NOT NULL, entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL, details TEXT DEFAULT '{}'
        );
        INSERT INTO audit_logs (id, ts, actor, action, entity_type, entity_id, details)
          VALUES ('legacy-1', '2026-01-01T00:00:00.000Z', 'human', 'PROJECT_CREATED',
                  'project', 'p1', '{"name":"old"}');
      `);
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[]
        ).map((c) => c.name);
        for (const c of ['reason', 'result', 'summary_hash', 'prev_hash']) {
          assert.ok(cols.includes(c), `migration adds ${c}`);
        }
        const log = new AuditLog(fdb.audit);
        const legacy = log.list()[0];
        assert.equal(legacy.id, 'legacy-1');
        assert.equal(legacy.action, 'PROJECT_CREATED');
        // Legacy means ABSENT fields — not nulls, not invented hashes.
        assert.equal('summaryHash' in legacy, false);
        assert.equal('prevHash' in legacy, false);
        assert.equal('reason' in legacy, false);
        assert.equal('result' in legacy, false);

        // New chained records append after the legacy row and verify;
        // the legacy row is counted, never treated as corruption.
        log.record('human', 'TASK_CREATED', 'task', 't9', {}, { result: 'SUCCEEDED' });
        assert.deepEqual(log.verify(), { ok: true, verifiedCount: 1, legacyCount: 1 });
      } finally {
        fdb.close();
      }

      // Reopen once more: legacy stays legacy, the chained record verifies.
      const fdb2 = new FactoryDatabase(file);
      try {
        const log2 = new AuditLog(fdb2.audit);
        assert.deepEqual(log2.verify(), { ok: true, verifiedCount: 1, legacyCount: 1 });
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteStepIntentStore (§28.1)', () => {
  it('is a runtime StepIntentStore and round-trips intents across instances on one file', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      const store1 = new SqliteStepIntentStore(fdb1.db, fixedClock);
      assert.ok(store1 instanceof StepIntentStore, 'assignable wherever runAgent takes a StepIntentStore');

      const i1 = store1.persistIntent('run-1', 'echo', { msg: 'hi' }, 'cap:echo');
      const i2 = store1.persistIntent('run-1', 'add', { a: 1, b: 2 });
      const done = store1.recordResult(i1.id, true, { ok: true, echo: 'hi' });
      assert.equal(done.status, 'EXECUTED');
      assert.equal(i2.status, 'PENDING');
      assert.equal(i2.capabilityRef, undefined);

      // Hash parity with the in-memory store: durable storage must not
      // quietly change what an intent commits to.
      const mem = new StepIntentStore(fixedClock);
      const mi = mem.persistIntent('run-1', 'echo', { msg: 'hi' }, 'cap:echo');
      assert.equal(i1.argsHash, mi.argsHash);
      assert.equal(i1.persistedAt, mi.persistedAt);
      const mdone = mem.recordResult(mi.id, true, { ok: true, echo: 'hi' });
      assert.equal(done.resultHash, mdone.resultHash);

      const before = store1.listIntents();
      assert.equal(before.length, 2);
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const store2 = fdb2.stepIntents;
        assert.deepEqual(store2.listIntents(), before);
        assert.deepEqual(store2.listIntents('run-1'), before);
        assert.deepEqual(store2.listIntents('no-such-run'), []);
        const pending = store2.pendingIntents();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].id, i2.id);
        assert.equal(pending[0].status, 'PENDING');
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listInterrupted() finds what a dead process left — and never mutates it', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      const store = fdb.stepIntents;
      const a = store.persistIntent('run-dead', 'echo', { msg: 'a' });
      const b = store.persistIntent('run-dead', 'deploy', { env: 'prod' });
      store.recordResult(a.id, true, { ok: true });

      const scan1 = store.listInterrupted();
      assert.equal(scan1.length, 1);
      assert.equal(scan1[0].id, b.id);
      // Scanning again finds the same row — the scan is a read, and the
      // row in the table is untouched (still PENDING, no result hash).
      assert.deepEqual(store.listInterrupted(), scan1);
      const row = fdb.db
        .prepare('SELECT status, result_hash FROM step_intents WHERE id = ?')
        .get(b.id) as { status: string; result_hash: string | null };
      assert.equal(row.status, 'PENDING');
      assert.equal(row.result_hash, null);

      // Disposition stays possible afterwards: the upper layer can still
      // commit a (failed) result for the interrupted intent.
      const resolved = store.recordResult(b.id, false, { error: 'abandoned at startup' });
      assert.equal(resolved.status, 'FAILED');
      assert.equal(store.listInterrupted().length, 0);
    } finally {
      fdb.close();
    }
  });

  it('recordResult on an unknown intent fails with INTENT_NOT_FOUND, like the in-memory store', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      assert.throws(
        () => fdb.stepIntents.recordResult('missing-id', true, {}),
        (e: unknown) => e instanceof FactoryError && e.code === 'INTENT_NOT_FOUND',
      );
      assert.throws(
        () => new StepIntentStore().recordResult('missing-id', true, {}),
        (e: unknown) => e instanceof FactoryError && e.code === 'INTENT_NOT_FOUND',
      );
    } finally {
      fdb.close();
    }
  });
});
