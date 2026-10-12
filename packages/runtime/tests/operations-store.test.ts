/**
 * OperationStore seam — SPEC v2 §28.2 (G-59).
 *
 * The OperationLedger state machine reads/writes only through the
 * OperationStore interface; the default is the in-memory store (the
 * pre-G-59 Maps), and durable deployments inject a persistent one
 * (SqliteOperationStore in @ai-factory/db). These tests pin the seam
 * itself: an injected store really is the ledger's backing (not a
 * decorative option), and any conforming store yields the same state
 * machine behavior.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryOperationStore,
  OperationLedger,
  type ExternalOperation,
  type OperationStore,
} from '../src/index';

/** A second, independent OperationStore implementation (array-backed). */
class ArrayOperationStore implements OperationStore {
  readonly rows: ExternalOperation[] = [];
  getById(id: string): ExternalOperation | undefined {
    const op = this.rows.find((r) => r.id === id);
    return op ? { ...op } : undefined;
  }
  getByIdempotencyKey(key: string): ExternalOperation | undefined {
    const op = this.rows.find((r) => r.idempotencyKey === key);
    return op ? { ...op } : undefined;
  }
  put(op: ExternalOperation): void {
    const i = this.rows.findIndex((r) => r.id === op.id);
    if (i >= 0) this.rows[i] = { ...op };
    else this.rows.push({ ...op });
  }
  list(): ExternalOperation[] {
    return this.rows.map((r) => ({ ...r }));
  }
}

/** Snapshot with the random id factored out, keyed by idempotency key. */
function snapshot(ops: ExternalOperation[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const { id: _id, ...rest } = op;
    out[op.idempotencyKey] = rest;
  }
  return out;
}

function driveScript(ledger: OperationLedger): void {
  const a = ledger.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false });
  ledger.dispatch(a.id);
  ledger.confirm(a.id, true, 'deploy-7');
  // Same logical action again: idempotent prepare, no second record.
  ledger.prepare({ logicalAction: 'deploy', candidateDigest: 'c1', environment: 'prod', reversible: false });
  const b = ledger.prepare({ logicalAction: 'pr:create', candidateDigest: 'c2', environment: 'dev', reversible: true });
  ledger.dispatch(b.id);
  ledger.markUnknown(b.id, 'timeout');
}

describe('OperationStore seam (§28.2)', () => {
  it('the default ledger is backed by InMemoryOperationStore semantics (copies, not live refs)', () => {
    const ledger = new OperationLedger({ now: () => 5_000 });
    const op = ledger.prepare({ logicalAction: 'x', candidateDigest: 'c', environment: 'e', reversible: true });
    // Mutating the returned copy must not reach the stored record.
    op.state = 'CONFIRMED_FAILED';
    assert.equal(ledger.get(op.id)?.state, 'PREPARED');
    const listed = ledger.listOperations();
    listed[0].state = 'UNKNOWN';
    assert.equal(ledger.get(op.id)?.state, 'PREPARED');
  });

  it('an injected store is the real backing: same script, same ledger state', () => {
    const backing = new ArrayOperationStore();
    const a = new OperationLedger({ now: () => 1_000, store: backing });
    const b = new OperationLedger({ now: () => 1_000 });
    driveScript(a);
    driveScript(b);
    assert.deepEqual(snapshot(a.listOperations()), snapshot(b.listOperations()));
    // The injected store saw every record — writes did not bypass it.
    assert.equal(backing.rows.length, 2);
    assert.deepEqual(snapshot(backing.list()), snapshot(b.listOperations()));
  });

  it('listOperations filters by state and defaults to insertion order', () => {
    const ledger = new OperationLedger({ now: () => 1_000 });
    driveScript(ledger);
    assert.equal(ledger.listOperations().length, 2);
    assert.deepEqual(ledger.listOperations('CONFIRMED_SUCCEEDED').map((o) => o.logicalAction), ['deploy']);
    assert.deepEqual(ledger.listOperations('UNKNOWN').map((o) => o.logicalAction), ['pr:create']);
    assert.deepEqual(ledger.listOperations('PREPARED'), []);
  });

  it('InMemoryOperationStore keeps the idempotency index across put() updates', () => {
    const store = new InMemoryOperationStore();
    const ledger = new OperationLedger({ now: () => 1_000, store });
    const op = ledger.prepare({ logicalAction: 'x', candidateDigest: 'c', environment: 'e', reversible: true });
    ledger.dispatch(op.id);
    const byKey = store.getByIdempotencyKey(op.idempotencyKey);
    assert.equal(byKey?.id, op.id);
    assert.equal(byKey?.state, 'DISPATCHED');
    assert.equal(byKey?.attempts, 1);
  });
});
