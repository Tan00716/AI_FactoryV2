/**
 * Durable delegation records — SPEC v2 §12.2, §48.2 (Batch 32).
 *
 * Until Batch 32 the DelegationManager was pure process memory: a
 * restart forgot every delegation — who was authorized to do what,
 * under which supervision, with what budget reservation. This file is
 * the record layer only: one row per delegation_id holding the full
 * Delegation JSON (lossless) plus indexable projections. The §12.2
 * rules (scope subset, budget carving, depth, acyclicity, supervision
 * retention) stay in @ai-factory/orchestrator; this file stays
 * dependency-free of it.
 *
 * Record semantics (pinned by tests):
 *  - save is an upsert keyed by delegation_id (write-through on every
 *    manager mutation); rows are never implicitly deleted.
 *  - Statuses mirror the orchestrator vocabulary, plus INTERRUPTED —
 *    the honest post-restart state (see below). INTERRUPTED is a
 *    record-layer state, not a DelegationManager transition: it means
 *    "this delegation was ACTIVE when the owning process died; no
 *    process supervises it now, its real-world fate is UNKNOWN, and
 *    it will never be auto-resumed". The server demotes ACTIVE rows
 *    to INTERRUPTED on hydrate (write-back) and never loads
 *    INTERRUPTED rows into the live manager — they are read-only
 *    history; a new delegation takes a new id.
 *  - DRAFT/COMPLETED/CANCELLED hydrate as-is: DRAFT never started
 *    (no liveness claim), terminal states are historical facts.
 *  - markInterrupted(id, at) demotes ONLY an ACTIVE row (no-op for
 *    unknown ids or non-ACTIVE rows); it never touches version —
 *    the demotion is a record-layer honesty stamp, not a delegation
 *    decision, and rehydratedAt records when it happened.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * Record-layer status vocabulary: the orchestrator's four states plus
 * INTERRUPTED (see module doc). Deliberately NOT the orchestrator's
 * DelegationStatus — that union is the live manager's business.
 */
export type PersistedDelegationStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export interface DelegationDbRecord {
  delegationId: string;
  parentDelegationId: string | null;
  delegator: string;
  delegatee: string;
  taskId: string;
  status: PersistedDelegationStatus;
  version: number;
  /** Full @ai-factory/orchestrator Delegation JSON (lossless). */
  recordJson: string;
  createdAt: string;
  updatedAt: string;
  /** ISO time of a post-restart ACTIVE→INTERRUPTED demotion; null otherwise. */
  rehydratedAt: string | null;
}

export interface DelegationStore {
  /** Upsert keyed by delegation_id. */
  save(record: DelegationDbRecord): void;
  get(delegationId: string): DelegationDbRecord | undefined;
  list(): DelegationDbRecord[];
  listByStatus(status: PersistedDelegationStatus): DelegationDbRecord[];
  /**
   * Demote an ACTIVE row to INTERRUPTED (post-restart honesty).
   * No-op when the row is unknown or not ACTIVE. Never touches
   * version. Returns true when a demotion happened.
   */
  markInterrupted(delegationId: string, at: string): boolean;
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryDelegationStore implements DelegationStore {
  private readonly map = new Map<string, DelegationDbRecord>();

  save(record: DelegationDbRecord): void {
    this.map.set(record.delegationId, copy(record));
  }

  get(delegationId: string): DelegationDbRecord | undefined {
    const r = this.map.get(delegationId);
    return r === undefined ? undefined : copy(r);
  }

  list(): DelegationDbRecord[] {
    return [...this.map.values()]
      .map(copy)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listByStatus(status: PersistedDelegationStatus): DelegationDbRecord[] {
    return this.list().filter((r) => r.status === status);
  }

  markInterrupted(delegationId: string, at: string): boolean {
    const r = this.map.get(delegationId);
    if (r === undefined || r.status !== 'ACTIVE') return false;
    this.map.set(delegationId, { ...r, status: 'INTERRUPTED', rehydratedAt: at });
    return true;
  }
}

function rowToRecord(row: Record<string, unknown>): DelegationDbRecord {
  return {
    delegationId: row['delegation_id'] as string,
    parentDelegationId: (row['parent_delegation_id'] as string | null) ?? null,
    delegator: row['delegator'] as string,
    delegatee: row['delegatee'] as string,
    taskId: row['task_id'] as string,
    status: row['status'] as PersistedDelegationStatus,
    version: row['version'] as number,
    recordJson: row['record_json'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    rehydratedAt: (row['rehydrated_at'] as string | null) ?? null,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteDelegationStore implements DelegationStore {
  constructor(private readonly db: DatabaseSync) {}

  save(r: DelegationDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO delegations
           (delegation_id, parent_delegation_id, delegator, delegatee, task_id,
            status, version, record_json, created_at, updated_at, rehydrated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delegation_id) DO UPDATE SET
           parent_delegation_id=excluded.parent_delegation_id,
           delegator=excluded.delegator,
           delegatee=excluded.delegatee,
           task_id=excluded.task_id,
           status=excluded.status,
           version=excluded.version,
           record_json=excluded.record_json,
           updated_at=excluded.updated_at,
           rehydrated_at=excluded.rehydrated_at`,
      )
      .run(
        r.delegationId,
        r.parentDelegationId,
        r.delegator,
        r.delegatee,
        r.taskId,
        r.status,
        r.version,
        r.recordJson,
        r.createdAt,
        r.updatedAt,
        r.rehydratedAt,
      );
  }

  get(delegationId: string): DelegationDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE delegation_id = ?')
      .get(delegationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  list(): DelegationDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM delegations ORDER BY created_at ASC, rowid ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  listByStatus(status: PersistedDelegationStatus): DelegationDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM delegations WHERE status = ? ORDER BY created_at ASC, rowid ASC')
      .all(status) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  markInterrupted(delegationId: string, at: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE delegations
         SET status = 'INTERRUPTED', rehydrated_at = ?
         WHERE delegation_id = ? AND status = 'ACTIVE'`,
      )
      .run(at, delegationId);
    return Number(res.changes) > 0;
  }
}
