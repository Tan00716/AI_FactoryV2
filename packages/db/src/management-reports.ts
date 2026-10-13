/**
 * Durable §14 management-report records — SPEC v2 §48.2 (Batch 34).
 *
 * Until Batch 34 the only home for a ManagementReport was
 * `ReportLog`, a process-memory Map in @ai-factory/comms (with a
 * per-task lastSequence guard). A restart forgot every submitted
 * report and, worse, reset the sequence monotonicity guard — a stale
 * report could be re-submitted after reboot. This file is the record
 * layer: one row per report_id, storing the full validated report
 * JSON plus projection columns. The domain's validation (schema
 * version, required fields, id uniqueness, sequence monotonicity,
 * ref existence, actor-from-auth, system-field injection+freeze) stays
 * in ReportLog — the store persists only already-validated reports.
 *
 * Record semantics (pinned by tests):
 *  - saveReport is INSERT-only: a duplicate report_id fails loudly
 *    (SQLite UNIQUE names the report_id column — see AGENTS.md);
 *  - updateReport is a conditional full-row replace: it only rewrites a
 *    row that is currently SUBMITTED_FOR_REVIEW (the only non-terminal
 *    submit-time status with a domain transition). Both the status
 *    projection column AND the stored report JSON are rewritten, so
 *    the two can never disagree. Returns true when the row was
 *    rewritten, false otherwise — the domain already validated the
 *    transition before calling, so false is a loud anomaly, not a
 *    second decision path;
 *  - listByTaskId returns sequence order (oldest first), matching
 *    ReportLog.listByTask.
 *
 * Restart semantics (honest determination, Batch 34): reports are
 * historical records, not executions. A row left SUBMITTED_FOR_REVIEW
 * at kill time means "submitted, no decision recorded yet" — which is
 * exactly as true after the restart as before it, because decisions
 * only ever flow through ReportLog.decideReport (also written
 * through). There is no liveness claim to demote (unlike delegations'
 * ACTIVE, Batch 32, or pipeline RUNNING, Batch 31). Rows therefore
 * hydrate as-is; the one thing that MUST be rebuilt is the
 * per-task lastSequence guard (ReportLog.loadSnapshot), or stale
 * sequences would be accepted after reboot.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 */
import { DatabaseSync } from 'node:sqlite';

/** Stored shape: the full validated report JSON plus projection columns. */
export interface ManagementReportDbRecord {
  reportId: string;
  taskId: string;
  reportSequence: number;
  /** ManagementReportStatus at store time: DRAFT | SUBMITTED_FOR_REVIEW | ACCEPTED | REJECTED | ESCALATED. */
  status: string;
  /** JSON of the full validated ManagementReport (system object included). */
  reportJson: string;
  /** ms epoch when the row was last written (moves on decision rewrite). */
  createdAt: number;
}

export interface ManagementReportStore {
  /** Insert one row. Duplicate report_id fails loudly. */
  saveReport(record: ManagementReportDbRecord): void;
  getReport(reportId: string): ManagementReportDbRecord | undefined;
  /** All reports for one task, oldest first (report_sequence ASC). */
  listByTaskId(taskId: string): ManagementReportDbRecord[];
  /** All reports, oldest-written first (used for boot hydration). */
  listReports(): ManagementReportDbRecord[];
  /**
   * Conditional full-row replace for a decision: rewrites the row only
   * when it is currently SUBMITTED_FOR_REVIEW (status column AND
   * report JSON are both rewritten, atomically).
   * Returns true when the row was rewritten; false when the row is
   * missing or no longer SUBMITTED_FOR_REVIEW.
   */
  updateReport(record: ManagementReportDbRecord): boolean;
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryManagementReportStore implements ManagementReportStore {
  private readonly rows = new Map<string, ManagementReportDbRecord>();

  saveReport(record: ManagementReportDbRecord): void {
    if (this.rows.has(record.reportId)) {
      // Mirror the SQLite UNIQUE-on-report_id failure loudly, in-memory too.
      throw new Error(
        `UNIQUE constraint failed: management_reports.report_id (${record.reportId})`,
      );
    }
    this.rows.set(record.reportId, copy(record));
  }

  getReport(reportId: string): ManagementReportDbRecord | undefined {
    const r = this.rows.get(reportId);
    return r === undefined ? undefined : copy(r);
  }

  listByTaskId(taskId: string): ManagementReportDbRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.reportSequence - b.reportSequence)
      .map((r) => copy(r));
  }

  listReports(): ManagementReportDbRecord[] {
    return [...this.rows.values()].map((r) => copy(r));
  }

  updateReport(record: ManagementReportDbRecord): boolean {
    const r = this.rows.get(record.reportId);
    if (!r || r.status !== 'SUBMITTED_FOR_REVIEW') return false;
    this.rows.set(record.reportId, copy(record));
    return true;
  }
}

function rowToReport(row: Record<string, unknown>): ManagementReportDbRecord {
  // Corrupt rows fail loudly: JSON.parse throws rather than guessing.
  const reportJson = row['report_json'] as string;
  JSON.parse(reportJson);
  return {
    reportId: row['report_id'] as string,
    taskId: row['task_id'] as string,
    reportSequence: row['report_sequence'] as number,
    status: row['status'] as string,
    reportJson,
    createdAt: row['created_at'] as number,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteManagementReportStore implements ManagementReportStore {
  constructor(private readonly db: DatabaseSync) {}

  saveReport(r: ManagementReportDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO management_reports
           (report_id, task_id, report_sequence, status, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.reportId, r.taskId, r.reportSequence, r.status, r.reportJson, r.createdAt);
  }

  getReport(reportId: string): ManagementReportDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM management_reports WHERE report_id = ?')
      .get(reportId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToReport(row);
  }

  listByTaskId(taskId: string): ManagementReportDbRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM management_reports
         WHERE task_id = ? ORDER BY report_sequence ASC, rowid ASC`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToReport);
  }

  listReports(): ManagementReportDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM management_reports ORDER BY rowid ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToReport);
  }

  updateReport(r: ManagementReportDbRecord): boolean {
    const res = this.db
      .prepare(
        `UPDATE management_reports
         SET task_id = ?, report_sequence = ?, status = ?, report_json = ?, created_at = ?
         WHERE report_id = ? AND status = 'SUBMITTED_FOR_REVIEW'`,
      )
      .run(r.taskId, r.reportSequence, r.status, r.reportJson, r.createdAt, r.reportId);
    return Number(res.changes) === 1;
  }
}
