/**
 * Durable self-modification proposals — SPEC v2 §59, §48.2 (Batch 33).
 *
 * Until Batch 33 a §59 self-modification proposal lived only in the
 * HTTP response of POST /api/workforce/proposals: proposeChange is a
 * pure function, nothing ever stored the decision. A restart (or even
 * just not saving the response) lost every proposal.
 *
 * This file is the record layer: one insert-only row per proposal
 * decision holding the full Proposal JSON plus indexable projections.
 * Record semantics (pinned by tests):
 *  - save appends an insert-only row (proposal ids are UUIDs; a
 *    duplicate id is a real error, not an upsert);
 *  - a Proposal's status (auto-approved / denied / needs-review) is
 *    terminal at decision time. `needs-review` is a flag for humans,
 *    not an in-flight state this system advances — there is no review
 *    endpoint, so no restart downgrade is needed and none is invented.
 *    Rows hydrate as-is.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 */
import { DatabaseSync } from 'node:sqlite';

export interface ProposalDbRecord {
  id: string;
  kind: string;
  target: string;
  /** Full rationale text as submitted. */
  rationale: string;
  requestedBy: string;
  /** Terminal at decision time: auto-approved | denied | needs-review. */
  status: string;
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

export interface ProposalStore {
  /** Insert-only. Never edits or removes existing rows. */
  save(record: ProposalDbRecord): void;
  get(id: string): ProposalDbRecord | undefined;
  /** Newest-first (decidedAt DESC, rowid DESC tie-break). */
  list(status?: string): ProposalDbRecord[];
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryProposalStore implements ProposalStore {
  private readonly rows: ProposalDbRecord[] = [];

  save(record: ProposalDbRecord): void {
    this.rows.push(copy(record));
  }

  get(id: string): ProposalDbRecord | undefined {
    const r = this.rows.find((r) => r.id === id);
    return r === undefined ? undefined : copy(r);
  }

  list(status?: string): ProposalDbRecord[] {
    return this.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => status === undefined || r.status === status)
      .sort((a, b) => b.r.decidedAt.localeCompare(a.r.decidedAt) || b.i - a.i)
      .map(({ r }) => copy(r));
  }
}

function rowToProposal(row: Record<string, unknown>): ProposalDbRecord {
  return {
    id: row['id'] as string,
    kind: row['kind'] as string,
    target: row['target'] as string,
    rationale: row['rationale'] as string,
    requestedBy: row['requested_by'] as string,
    status: row['status'] as string,
    decidedBy: row['decided_by'] as string,
    reason: row['reason'] as string,
    decidedAt: row['decided_at'] as string,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteProposalStore implements ProposalStore {
  constructor(private readonly db: DatabaseSync) {}

  save(r: ProposalDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals
           (id, kind, target, rationale, requested_by,
            status, decided_by, reason, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.kind,
        r.target,
        r.rationale,
        r.requestedBy,
        r.status,
        r.decidedBy,
        r.reason,
        r.decidedAt,
      );
  }

  get(id: string): ProposalDbRecord | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToProposal(row);
  }

  list(status?: string): ProposalDbRecord[] {
    const rows =
      status === undefined
        ? (this.db
            .prepare('SELECT * FROM proposals ORDER BY decided_at DESC, rowid DESC')
            .all() as Record<string, unknown>[])
        : (this.db
            .prepare('SELECT * FROM proposals WHERE status = ? ORDER BY decided_at DESC, rowid DESC')
            .all(status) as Record<string, unknown>[]);
    return rows.map(rowToProposal);
  }
}
