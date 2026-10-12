/**
 * Durable external operations — SPEC v2 §28.2 (G-59, Batch 10).
 *
 * The runtime OperationLedger state machine used to hold its records in
 * a private in-memory Map: a restart lost every PREPARED/DISPATCHED/
 * UNKNOWN operation, so reconcile() had nothing to reconcile. The
 * ledger now writes through the OperationStore interface, and this file
 * pins the SQLite implementation (external_operations table):
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results;
 *  - fidelity across instances: a new process over the same file reads
 *    back every field exactly (timestamps, attempts, optional lifecycle
 *    fields present-or-absent), and idempotent prepare after a restart
 *    returns the persisted operation instead of duplicating it;
 *  - startup reconcile: pre-seeded non-terminal operations classify
 *    under a target that cannot answer (reversible ⇒ safe-to-retry,
 *    irreversible ⇒ needs-manual-recovery), the classification mutates
 *    nothing, and a later adoption via an answering target persists.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryError,
  InMemoryOperationStore,
  OperationLedger,
  type ExternalOperation,
  type TargetLedgerQuery,
} from '@ai-factory/runtime';
import { FactoryDatabase, SCHEMA, SqliteOperationStore } from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-ops-'));
  return { dir, file: join(dir, 'factory.db') };
}

/** Replace the random id with the (unique, script-chosen) logical action. */
function normalized(op: ExternalOperation): Record<string, unknown> {
  const { id: _id, ...rest } = op;
  return { ref: op.logicalAction, ...rest };
}

const SILENT_TARGET: TargetLedgerQuery = { findByIdempotencyKey: () => undefined };

describe('SqliteOperationStore behavior parity (§28.2)', () => {
  it('the same scripted sequence yields identical results on memory and SQLite stores', () => {
    const sqlite = new DatabaseSync(':memory:');
    // The table normally comes from FactoryDatabase's SCHEMA exec; a bare
    // DatabaseSync needs the same DDL before the store is usable.
    sqlite.exec(SCHEMA);

    let t = 1_000;
    const now = () => t;
    const memLedger = new OperationLedger({ now, store: new InMemoryOperationStore() });
    const sqlLedger = new OperationLedger({ now, store: new SqliteOperationStore(sqlite) });

    const trace: Array<{ mem: unknown; sql: unknown }> = [];
    const both = (fn: (l: OperationLedger) => unknown): void => {
      trace.push({ mem: fn(memLedger), sql: fn(sqlLedger) });
    };

    both((l) => normalized(l.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false })));
    // Idempotent prepare: same key returns the same operation, no duplicate.
    let memDeployId = '';
    let sqlDeployId = '';
    both((l) => {
      const again = l.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false });
      if (l === memLedger) memDeployId = again.id;
      else sqlDeployId = again.id;
      return normalized(again);
    });
    t = 2_000;
    both((l) => normalized(l.dispatch(l.listOperations()[0].id)));
    t = 3_000;
    both((l) => normalized(l.confirm(l.listOperations()[0].id, true, 'deploy-7')));
    t = 4_000;
    both((l) => normalized(l.prepare({ logicalAction: 'pr:create', candidateDigest: 'c2', environment: 'dev', reversible: true })));
    t = 5_000;
    both((l) => normalized(l.dispatch(l.listOperations('PREPARED')[0].id)));
    both((l) => normalized(l.markUnknown(l.listOperations('DISPATCHED')[0].id, 'timeout')));
    both((l) => normalized(l.prepare({ logicalAction: 'ci:run', candidateDigest: 'c3', environment: 'dev', reversible: true })));

    // Error contract parity: invalid transition + unknown id.
    for (const l of [memLedger, sqlLedger]) {
      const confirmed = l.listOperations('CONFIRMED_SUCCEEDED')[0];
      assert.throws(
        () => l.dispatch(confirmed.id),
        (e: unknown) => e instanceof FactoryError && e.code === 'INVALID_OP_TRANSITION',
      );
      assert.throws(
        () => l.dispatch('no-such-id'),
        (e: unknown) => e instanceof FactoryError && e.code === 'OP_NOT_FOUND',
      );
      assert.equal(l.get('no-such-id'), undefined);
    }
    // Within each ledger the idempotent prepare returned the original id.
    assert.equal(memLedger.listOperations().length, 3);
    assert.equal(sqlLedger.listOperations().length, 3);
    assert.ok(memDeployId.length > 0 && sqlDeployId.length > 0);

    for (const step of trace) assert.deepEqual(step.sql, step.mem);
    assert.deepEqual(
      sqlLedger.listOperations().map(normalized),
      memLedger.listOperations().map(normalized),
    );
    sqlite.close();
  });
});

describe('SqliteOperationStore durability (§28.2)', () => {
  it('round-trips every field across instances; idempotent prepare survives a restart', () => {
    const { dir, file } = tmpDbFile();
    try {
      let t = 10_000;
      const now = () => t;
      const fdb1 = new FactoryDatabase(file);
      const ledger1 = new OperationLedger({ now, store: fdb1.operations });
      const done = ledger1.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false });
      t = 11_000;
      ledger1.dispatch(done.id);
      t = 12_000;
      ledger1.confirm(done.id, true, 'deploy-7');
      const lost = ledger1.prepare({ logicalAction: 'db:migrate', candidateDigest: 'c2', environment: 'prod', reversible: false });
      t = 13_000;
      ledger1.dispatch(lost.id);
      ledger1.markUnknown(lost.id, 'worker killed');
      const before = ledger1.listOperations();
      assert.equal(before.length, 2);
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const ledger2 = new OperationLedger({ store: fdb2.operations });
        // Field-for-field: timestamps, attempts, idempotency keys, and
        // optional fields present exactly where the state machine set
        // them (confirmedAt+ledgerRef on one, lastError on the other).
        assert.deepEqual(ledger2.listOperations(), before);
        const doneBack = ledger2.get(done.id);
        assert.equal(doneBack?.confirmedAt, 12_000);
        assert.equal(doneBack?.ledgerRef, 'deploy-7');
        assert.equal('lastError' in (doneBack ?? {}), false);
        const lostBack = ledger2.get(lost.id);
        assert.equal(lostBack?.state, 'UNKNOWN');
        assert.equal(lostBack?.lastError, 'worker killed');
        assert.equal(lostBack?.dispatchedAt, 13_000);
        assert.equal('confirmedAt' in (lostBack ?? {}), false);

        // The restart must not duplicate a logical action: preparing the
        // same action returns the PERSISTED operation (same id, already
        // confirmed), not a fresh PREPARED row.
        const again = ledger2.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false });
        assert.equal(again.id, done.id);
        assert.equal(again.state, 'CONFIRMED_SUCCEEDED');
        assert.equal(ledger2.listOperations().length, 2);
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startup reconcile classifies pre-seeded non-terminal ops and mutates nothing; adoption persists', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      const seed = new OperationLedger({ store: fdb1.operations });
      const migrate = seed.prepare({ logicalAction: 'db:migrate', candidateDigest: 'c1', environment: 'prod', reversible: false });
      seed.dispatch(migrate.id);
      seed.markUnknown(migrate.id, 'process killed');
      const hook = seed.prepare({ logicalAction: 'webhook:send', candidateDigest: 'c2', environment: 'prod', reversible: true });
      seed.dispatch(hook.id);
      seed.prepare({ logicalAction: 'report:build', candidateDigest: 'c3', environment: 'prod', reversible: true });
      const finished = seed.prepare({ logicalAction: 'deploy', candidateDigest: 'c4', environment: 'prod', reversible: false });
      seed.dispatch(finished.id);
      seed.confirm(finished.id, true, 'deploy-1');
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const ledger = new OperationLedger({ store: fdb2.operations });
        const all = ledger.listOperations();
        const nonTerminal = all.filter(
          (o) => o.state !== 'CONFIRMED_SUCCEEDED' && o.state !== 'CONFIRMED_FAILED',
        );
        assert.equal(nonTerminal.length, 3);

        // Exactly the server's startup pass: existing reconcile(), target
        // cannot answer at boot.
        const verdicts = new Map(
          nonTerminal.map((op) => [op.logicalAction, ledger.reconcile(op.id, SILENT_TARGET).action]),
        );
        assert.equal(verdicts.get('db:migrate'), 'needs-manual-recovery');
        assert.equal(verdicts.get('webhook:send'), 'safe-to-retry');
        assert.equal(verdicts.get('report:build'), 'safe-to-retry');

        // Classification is not disposition: with a silent target,
        // reconcile adopts nothing and changes no state.
        assert.deepEqual(ledger.listOperations(), all);

        // When a target CAN answer, adoption goes through confirm() and
        // is durable like any other transition.
        const adopted = ledger.reconcile(migrate.id, {
          findByIdempotencyKey: () => ({ outcome: 'succeeded', ledgerRef: 'mig-9' }),
        });
        assert.equal(adopted.action, 'already-done');
        assert.equal(adopted.operation.state, 'CONFIRMED_SUCCEEDED');
      } finally {
        fdb2.close();
      }

      const fdb3 = new FactoryDatabase(file);
      try {
        const ledger3 = new OperationLedger({ store: fdb3.operations });
        const back = ledger3.listOperations().find((o) => o.logicalAction === 'db:migrate');
        assert.equal(back?.state, 'CONFIRMED_SUCCEEDED');
        assert.equal(back?.ledgerRef, 'mig-9');
      } finally {
        fdb3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-G-59 database (no external_operations table) gains it on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(external_operations)').all() as { name: string }[]
        ).map((c) => c.name);
        for (const c of ['id', 'idempotency_key', 'state', 'reversible', 'prepared_at', 'attempts']) {
          assert.ok(cols.includes(c), `external_operations gains ${c}`);
        }
        const ledger = new OperationLedger({ store: fdb.operations });
        const op = ledger.prepare({ logicalAction: 'x', candidateDigest: 'c', environment: 'e', reversible: true });
        assert.equal(ledger.get(op.id)?.state, 'PREPARED');
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
