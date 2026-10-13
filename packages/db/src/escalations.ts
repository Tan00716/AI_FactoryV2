/**
 * Durable dispute-escalation records — SPEC v2 §48.2 (Batch 33).
 *
 * Until Batch 33 the only home for a dispute adjudication escalation
 * was `DisputeCoordinator.escalationRecords`, an in-memory array in
 * @ai-factory/evaluation (appended when adjudication gives up and
 * escalates to a human). A restart forgot every pending escalation.
 * This file is the record layer: an append-only log of escalation
 * records keyed by escalation_id. There is no update API and no
 * delete API — escalation records are historical facts (§39 sealed-
 * verdict style); a human decision on the pending actions would be
 * recorded as a NEW artifact (e.g. a resolved dispute or a gate
 * evaluation), never an edit of this row.
 *
 * Record semantics (pinned by tests):
 *  - recordEscalation appends; the store never edits or removes rows;
 *  - listEscalations returns newest-first so the freshest escalation
 *    is the first row (ties broken by rowid DESC in SQLite);
 *  - dispute escalations are synchronous, terminal records — there is
 *    no in-flight escalation state to demote on restart (unlike
 *    delegations, Batch 32). Rows hydrate as-is.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 *
 * NOT in scope (stated honestly, not invented): the §81
 * `needsHuman` escalation shape (packages/autonomy) has no server
 * emission point and no store anywhere — this store does NOT absorb
 * it. The §48.2 "escalations" entity that was "in process memory" is
 * the dispute-adjudication escalation, which is what this persists.
 */
import { DatabaseSync } from 'node:sqlite';

export interface EscalationDbRecord {
  escalationId: string;
  disputeId: string;
  /** JSON array of strings: why the evaluator could not resolve. */
  reasonsJson: string;
  /** JSON array of strings: concrete items awaiting a human decision. */
  pendingHumanActionsJson: string;
  /** JSON array of {side, agent, verdict, evidenceIds, weaknesses}. */
  evidenceBySideJson: string;
  createdAt: number;
}

export interface EscalationStore {
  /** Append one record. Never edits or removes existing rows. */
  recordEscalation(record: EscalationDbRecord): void;
  getEscalation(escalationId: string): EscalationDbRecord | undefined;
  /** Newest-first (createdAt DESC, rowid DESC tie-break). */
  listEscalations(disputeId?: string): EscalationDbRecord[];
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryEscalationStore implements EscalationStore {
  private readonly rows: EscalationDbRecord[] = [];

  recordEscalation(record: EscalationDbRecord): void {
    this.rows.push(copy(record));
  }

  getEscalation(escalationId: string): EscalationDbRecord | undefined {
    const r = this.rows.find((r) => r.escalationId === escalationId);
    return r === undefined ? undefined : copy(r);
  }

  listEscalations(disputeId?: string): EscalationDbRecord[] {
    return this.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => disputeId === undefined || r.disputeId === disputeId)
      .sort((a, b) => b.r.createdAt - a.r.createdAt || b.i - a.i)
      .map(({ r }) => copy(r));
  }
}

function rowToEscalation(row: Record<string, unknown>): EscalationDbRecord {
  // Corrupt rows fail loudly: JSON.parse throws rather than guessing.
  const reasonsJson = row['reasons_json'] as string;
  const actionsJson = row['pending_human_actions_json'] as string;
  const evidenceJson = row['evidence_by_side_json'] as string;
  JSON.parse(reasonsJson);
  JSON.parse(actionsJson);
  JSON.parse(evidenceJson);
  return {
    escalationId: row['escalation_id'] as string,
    disputeId: row['dispute_id'] as string,
    reasonsJson,
    pendingHumanActionsJson: actionsJson,
    evidenceBySideJson: evidenceJson,
    createdAt: row['created_at'] as number,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteEscalationStore implements EscalationStore {
  constructor(private readonly db: DatabaseSync) {}

  recordEscalation(r: EscalationDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO escalations
           (escalation_id, dispute_id, reasons_json,
            pending_human_actions_json, evidence_by_side_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.escalationId,
        r.disputeId,
        r.reasonsJson,
        r.pendingHumanActionsJson,
        r.evidenceBySideJson,
        r.createdAt,
      );
  }

  getEscalation(escalationId: string): EscalationDbRecord | undefined {
    const row = this.db.prepare('SELECT * FROM escalations WHERE escalation_id = ?').get(escalationId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToEscalation(row);
  }

  listEscalations(disputeId?: string): EscalationDbRecord[] {
    const rows =
      disputeId === undefined
        ? (this.db
            .prepare('SELECT * FROM escalations ORDER BY created_at DESC, rowid DESC')
            .all() as Record<string, unknown>[])
        : (this.db
            .prepare(
              'SELECT * FROM escalations WHERE dispute_id = ? ORDER BY created_at DESC, rowid DESC',
            )
            .all(disputeId) as Record<string, unknown>[]);
    return rows.map(rowToEscalation);
  }
}
