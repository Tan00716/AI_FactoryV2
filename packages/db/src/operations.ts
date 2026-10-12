/**
 * SQLite-backed OperationStore — SPEC v2 §28.2 (G-59).
 *
 * The runtime's OperationLedger state machine (PREPARED → DISPATCHED →
 * CONFIRMED_SUCCEEDED | CONFIRMED_FAILED | UNKNOWN, with reconcile
 * verdicts) reads and writes through the OperationStore interface; its
 * default implementation is an in-process Map, so every operation a
 * process prepared or dispatched vanished on restart and crash
 * reconciliation had nothing to read. This store keeps the exact same
 * contract on top of the external_operations table: same record shape,
 * same idempotency-key binding — only the backing changes.
 *
 * Why `implements OperationStore` (not `extends OperationLedger`): the
 * ledger is the state machine, the store is pure persistence. Unlike
 * StepIntentStore — whose consumers type the slot as the concrete
 * runtime class — OperationLedger's constructor takes the store as an
 * interface, so no subclassing is needed and the runtime keeps sole
 * ownership of transition rules and reconcile semantics.
 *
 * Serialization fidelity: timestamps are epoch milliseconds stored as
 * INTEGER; the optional lifecycle fields (dispatchedAt, confirmedAt,
 * ledgerRef, lastError) exist on the record only once the state machine
 * sets them, so a NULL column reads back as an ABSENT key — never as an
 * invented value and never as an explicit undefined.
 */

import { DatabaseSync } from 'node:sqlite';
import type { ExternalOperation, OperationStore } from '@ai-factory/runtime';

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' || typeof v === 'bigint' ? Number(v) : undefined;
}

function rowToOperation(r: Record<string, unknown>): ExternalOperation {
  const op: ExternalOperation = {
    id: r['id'] as string,
    idempotencyKey: r['idempotency_key'] as string,
    logicalAction: r['logical_action'] as string,
    candidateDigest: r['candidate_digest'] as string,
    environment: r['environment'] as string,
    state: r['state'] as ExternalOperation['state'],
    reversible: Number(r['reversible']) !== 0,
    preparedAt: Number(r['prepared_at']),
    attempts: Number(r['attempts']),
  };
  const dispatchedAt = optNum(r['dispatched_at']);
  if (dispatchedAt !== undefined) op.dispatchedAt = dispatchedAt;
  const confirmedAt = optNum(r['confirmed_at']);
  if (confirmedAt !== undefined) op.confirmedAt = confirmedAt;
  if (typeof r['ledger_ref'] === 'string') op.ledgerRef = r['ledger_ref'];
  if (typeof r['last_error'] === 'string') op.lastError = r['last_error'];
  return op;
}

export class SqliteOperationStore implements OperationStore {
  constructor(private readonly db: DatabaseSync) {}

  getById(id: string): ExternalOperation | undefined {
    const r = this.db
      .prepare('SELECT * FROM external_operations WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToOperation(r) : undefined;
  }

  getByIdempotencyKey(key: string): ExternalOperation | undefined {
    const r = this.db
      .prepare('SELECT * FROM external_operations WHERE idempotency_key = ?')
      .get(key) as Record<string, unknown> | undefined;
    return r ? rowToOperation(r) : undefined;
  }

  put(op: ExternalOperation): void {
    this.db
      .prepare(
        `INSERT INTO external_operations
           (id, idempotency_key, logical_action, candidate_digest, environment,
            state, reversible, prepared_at, dispatched_at, confirmed_at,
            ledger_ref, attempts, last_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state, dispatched_at=excluded.dispatched_at,
           confirmed_at=excluded.confirmed_at, ledger_ref=excluded.ledger_ref,
           attempts=excluded.attempts, last_error=excluded.last_error`,
      )
      .run(
        op.id, op.idempotencyKey, op.logicalAction, op.candidateDigest, op.environment,
        op.state, op.reversible ? 1 : 0, op.preparedAt,
        op.dispatchedAt ?? null, op.confirmedAt ?? null,
        op.ledgerRef ?? null, op.attempts, op.lastError ?? null,
      );
  }

  list(): ExternalOperation[] {
    // prepared_at ties (same millisecond, or an injected fixed clock)
    // break by rowid = insertion order, matching the in-memory store's
    // Map iteration order so behavior parity holds.
    return (
      this.db
        .prepare('SELECT * FROM external_operations ORDER BY prepared_at, rowid')
        .all() as Record<string, unknown>[]
    ).map(rowToOperation);
  }
}
