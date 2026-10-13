/**
 * Durable §81 "human should be an exception handler" upgrade records —
 * Batch 36.
 *
 * Until Batch 36, packages/autonomy's needsHuman() was a pure function
 * with tests and zero server emission points and zero stores anywhere
 * (disputes.ts, escalations.ts, index.ts each say so honestly). This file
 * is the record layer for the §81 shape: an append-only log of upgrade
 * records raised when a real server path needs a human.
 *
 * Emission (Batch 36): AUTHORITY_CONFLICT (§8.1, Batch 32) entering OPEN
 * state — two equally-valid, incompatible directives from same-rank
 * principals — maps to the §81 trigger 'ai-disagreement'. The emission
 * happens in apps/server (routes/authority.ts wires the registry's
 * onConflictOpened hook into this store). Only the 'ai-disagreement'
 * trigger has an emitter: the other seven §81 triggers have no server
 * emission point (stated honestly, not invented).
 *
 * Record semantics (pinned by tests):
 *  - submit insert-only (duplicate id throws loudly);
 *  - resolve is a conditional single-row update: only rows still 'open'
 *    may move to 'acknowledged'/'resolved'. Resolving an already
 *    terminal row returns false (409 NEEDS_HUMAN_ALREADY_TERMINAL at
 *    the HTTP layer) — terminal rows are never rewritten with a new
 *    status;
 *  - NOTHING ever auto-resolves a row: resolving the underlying
 *    authority conflict does not touch this row. A human marks the
 *    resolution explicitly via POST /api/needs-human/:id/resolve;
 *  - list is newest-first (raisedAt DESC, rowid DESC tie-break);
 *  - 'open' rows hydrate as-is on restart — an open upgrade is a
 *    request awaiting a human, not process state; "raised, no
 *    resolution recorded" holds before and after a restart
 *    (same reading as management_reports SUBMITTED_FOR_REVIEW,
 *    Batch 34). There is nothing to demote.
 *
 * Copy contract: every read returns a fresh deep copy.
 */
import { DatabaseSync } from 'node:sqlite';

export type NeedsHumanStatus = 'open' | 'acknowledged' | 'resolved';

export interface NeedsHumanDbRecord {
  id: string;
  /** One of the eight §81 triggers (HumanNeedReason in @ai-factory/autonomy). */
  reason: string;
  reasonZh: string;
  severity: 'medium' | 'high' | 'critical';
  /** Emission source, e.g. 'authority-conflict:ac-...'. */
  source: string;
  /**
   * Named human recipient, or null. The server has coarse-grained token
   * RBAC with no named human accounts, so this is honestly null for
   * system-raised upgrades; requiredDeciderLevel names the level the
   * recipient must hold.
   */
  recipient: string | null;
  /** Minimum authority level the resolving human must hold. */
  requiredDeciderLevel: string;
  /** JSON: {conflictId, target, directiveIds, incompatibleEffects, maxPartyRank, suggestion, ...}. */
  detailJson: string;
  /** JSON Record<string,string> traceability context. */
  contextJson: string;
  raisedAt: number;
  status: NeedsHumanStatus;
  resolvedAt: number | null;
  resolvedBy: string | null;
  /** Free-form human note recorded at resolution. */
  resolution: string | null;
}

export interface NeedsHumanStore {
  /** Insert-only. Duplicate id throws (loud, no silent replace). */
  submit(record: NeedsHumanDbRecord): void;
  get(id: string): NeedsHumanDbRecord | undefined;
  /** Newest-first (raisedAt DESC, rowid DESC tie-break). */
  list(status?: NeedsHumanStatus): NeedsHumanDbRecord[];
  /**
   * Mark an open row terminal. Returns true on success, false when the
   * row does not exist or is already terminal (never rewrites it).
   */
  resolve(
    id: string,
    status: 'acknowledged' | 'resolved',
    resolvedBy: string | null,
    resolution: string | null,
    resolvedAt: number,
  ): boolean;
}

const copy = <T>(v: T): T => structuredClone(v);

function assertTerminal(value: unknown, field: string): void {
  if (value !== 'open' && value !== 'acknowledged' && value !== 'resolved') {
    throw new Error(`corrupted needs_human_upgrades row: invalid ${field} ${JSON.stringify(value)}`);
  }
}

/** In-memory implementation: the behavior reference. */
export class InMemoryNeedsHumanStore implements NeedsHumanStore {
  private readonly rows: NeedsHumanDbRecord[] = [];

  submit(record: NeedsHumanDbRecord): void {
    if (this.rows.some((r) => r.id === record.id)) {
      throw new Error(`duplicate needs_human_upgrades id ${record.id}`);
    }
    this.rows.push(copy(record));
  }

  get(id: string): NeedsHumanDbRecord | undefined {
    const r = this.rows.find((r) => r.id === id);
    return r === undefined ? undefined : copy(r);
  }

  list(status?: NeedsHumanStatus): NeedsHumanDbRecord[] {
    return this.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => status === undefined || r.status === status)
      .sort((a, b) => b.r.raisedAt - a.r.raisedAt || b.i - a.i)
      .map(({ r }) => copy(r));
  }

  resolve(
    id: string,
    status: 'acknowledged' | 'resolved',
    resolvedBy: string | null,
    resolution: string | null,
    resolvedAt: number,
  ): boolean {
    const r = this.rows.find((r) => r.id === id);
    if (r === undefined || r.status !== 'open') return false;
    r.status = status;
    r.resolvedBy = resolvedBy;
    r.resolution = resolution;
    r.resolvedAt = resolvedAt;
    return true;
  }
}

function rowToRecord(row: Record<string, unknown>): NeedsHumanDbRecord {
  // Corrupt rows fail loudly: JSON.parse throws rather than guessing.
  const detailJson = row['detail_json'] as string;
  const contextJson = row['context_json'] as string;
  JSON.parse(detailJson);
  JSON.parse(contextJson);
  const status = row['status'] as unknown;
  assertTerminal(status, 'status');
  return {
    id: row['id'] as string,
    reason: row['reason'] as string,
    reasonZh: row['reason_zh'] as string,
    severity: row['severity'] as 'medium' | 'high' | 'critical',
    source: row['source'] as string,
    recipient: row['recipient'] as string | null,
    requiredDeciderLevel: row['required_decider_level'] as string,
    detailJson,
    contextJson,
    raisedAt: row['raised_at'] as number,
    status: status as NeedsHumanStatus,
    resolvedAt: row['resolved_at'] as number | null,
    resolvedBy: row['resolved_by'] as string | null,
    resolution: row['resolution'] as string | null,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteNeedsHumanStore implements NeedsHumanStore {
  constructor(private readonly db: DatabaseSync) {}

  submit(r: NeedsHumanDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO needs_human_upgrades
           (id, reason, reason_zh, severity, source, recipient,
            required_decider_level, detail_json, context_json, raised_at,
            status, resolved_at, resolved_by, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.reason,
        r.reasonZh,
        r.severity,
        r.source,
        r.recipient,
        r.requiredDeciderLevel,
        r.detailJson,
        r.contextJson,
        r.raisedAt,
        r.status,
        r.resolvedAt,
        r.resolvedBy,
        r.resolution,
      );
  }

  get(id: string): NeedsHumanDbRecord | undefined {
    const row = this.db.prepare('SELECT * FROM needs_human_upgrades WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  list(status?: NeedsHumanStatus): NeedsHumanDbRecord[] {
    const rows =
      status === undefined
        ? (this.db
            .prepare('SELECT * FROM needs_human_upgrades ORDER BY raised_at DESC, rowid DESC')
            .all() as Record<string, unknown>[])
        : (this.db
            .prepare(
              'SELECT * FROM needs_human_upgrades WHERE status = ? ORDER BY raised_at DESC, rowid DESC',
            )
            .all(status) as Record<string, unknown>[]);
    return rows.map(rowToRecord);
  }

  resolve(
    id: string,
    status: 'acknowledged' | 'resolved',
    resolvedBy: string | null,
    resolution: string | null,
    resolvedAt: number,
  ): boolean {
    // Conditional single-row update: terminal rows are never rewritten.
    const result = this.db
      .prepare(
        `UPDATE needs_human_upgrades
         SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(status, resolvedAt, resolvedBy, resolution, id);
    return (result.changes as number) === 1;
  }
}
