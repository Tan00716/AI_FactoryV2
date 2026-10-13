/**
 * §14 Structured Management Reports — schema 2.0.
 *
 * A report is an authoritative reference to / summary of a task object, not
 * a new statement of state. Reports support STATUS, WORK COMPLETED,
 * EVIDENCE, RISKS, BLOCKERS, DECISIONS NEEDED, NEXT ACTION and CONFIDENCE.
 * Task percentages are attached by the Progress Engine — the LLM does not
 * own that field.
 *
 * This module is the management-reporting protocol layer. It is distinct
 * from the §22 `report` channel primitive (a short verdict payload like a
 * QA pass/fail); a ManagementReport is the full §14 report object an
 * employee submits to their manager.
 *
 * Report Schema validation checks: ref existence, scope, time,
 * Employee/Run identity and sequence; repeated or old reports never
 * regress over newer facts.
 *
 * Security properties enforced by ReportLog.submitReport:
 *  - SYSTEM FIELDS ARE READ-ONLY: progress_snapshot_id, computed_progress,
 *    computed_at, current_gate are injected by the trusted caller. Any
 *    values smuggled inside the input are ignored/overwritten, and the
 *    attached `system` object is frozen on the stored report.
 *  - SEQUENCE MONOTONICITY: report_sequence must strictly increase per
 *    task_id. Repeated or old sequence numbers are rejected as
 *    duplicates — they never overwrite newer facts.
 *  - REF EXISTENCE: artifact_refs / evidence_refs are checked against an
 *    injected existence checker; dangling refs are rejected.
 *  - ACTOR FROM AUTH: employee_id comes from the authenticated `actor`
 *    parameter, never from a payload field.
 *  - self_assessed_confidence is a SUBJECTIVE value only: it is stored
 *    as-reported but must never be used as a calibrated probability or a
 *    Gate score. Gates use the system-attached computed_progress.
 */

export const REPORT_SCHEMA_VERSION = '2.0' as const;

/** §14 report lifecycle status. */
export type ManagementReportStatus =
  | 'DRAFT'
  | 'SUBMITTED_FOR_REVIEW'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'ESCALATED';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ReportRisk {
  severity: RiskSeverity;
  description: string;
}

/**
 * System-attached fields (§14: "系统另附 progress_snapshot_id,
 * computed_progress, computed_at, current_gate").
 *
 * READ-ONLY: injected by the trusted caller (Progress Engine / runtime),
 * never accepted from LLM-written input. ReportLog freezes this object on
 * the stored report.
 */
export interface SystemReportFields {
  progress_snapshot_id: string;
  computed_progress: number;
  computed_at: number;
  current_gate: string;
}

/**
 * §14 schema 2.0 management report.
 *
 * NOTE on self_assessed_confidence: this is the employee's SUBJECTIVE
 * self-assessment (0..1). It must NOT be treated as a calibrated
 * probability and must NOT be used as a Gate score — gates consume
 * `system.computed_progress`, which is computed by the Progress Engine.
 */
export interface ManagementReport {
  schema_version: typeof REPORT_SCHEMA_VERSION;
  report_id: string;
  task_id: string;
  requirement_version: string;
  /** Authenticated actor id — set from the submit context, never trusted from input. */
  employee_id: string;
  run_id: string;
  /** Strictly increasing per task_id; stale/duplicate sequences are rejected. */
  report_sequence: number;
  status: ManagementReportStatus;
  work_completed: string[];
  artifact_refs: string[];
  evidence_refs: string[];
  risks: ReportRisk[];
  blockers: string[];
  decisions_needed: string[];
  recommended_next_action: string;
  /**
   * Subjective self-assessment 0..1. NOT a calibrated probability and
   * MUST NOT be used as a Gate score (§14).
   */
  self_assessed_confidence: number;
  /** System-attached, read-only, frozen. */
  system: SystemReportFields;
}

/**
 * Input for ReportLog.submitReport. `employee_id` and `system` may be
 * present (e.g. echoed by an LLM) but are ALWAYS overridden by the
 * authenticated submit context — forged values are ignored.
 */
export type NewManagementReport = Omit<ManagementReport, 'employee_id' | 'system' | 'schema_version'> & {
  schema_version: string;
  employee_id?: string;
  system?: unknown;
};

/** Injected ref-existence check (§14 "Report Schema 验证引用存在性"). */
export interface RefExistenceChecker {
  artifactExists(id: string): boolean;
  evidenceExists(id: string): boolean;
}

/** Trusted submit context — none of these fields come from the LLM. */
export interface ReportSubmitContext {
  /** Authenticated actor id; becomes report.employee_id. */
  actor: string;
  /** Trusted system fields; overwrite anything in the input. */
  system: SystemReportFields;
  /** Existence checker for artifact_refs / evidence_refs. */
  refs: RefExistenceChecker;
}

export type ReportErrorCode =
  | 'INVALID_SCHEMA'
  | 'MISSING_FIELD'
  | 'DUPLICATE_REPORT'
  | 'STALE_SEQUENCE'
  | 'UNKNOWN_ARTIFACT_REF'
  | 'UNKNOWN_EVIDENCE_REF'
  | 'UNKNOWN_REPORT'
  | 'NOT_SUBMITTED'
  | 'INVALID_DECISION';

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}

const STATUSES: ReadonlyArray<ManagementReportStatus> = [
  'DRAFT',
  'SUBMITTED_FOR_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'ESCALATED',
];

const SEVERITIES: ReadonlyArray<RiskSeverity> = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReportError('MISSING_FIELD', `${field} is required`);
  }
  return value;
}

function strArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ReportError('INVALID_SCHEMA', `${field} must be a string array`);
  }
  return [...(value as string[])];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** self_assessed_confidence is required §14 input but remains subjective-only (see the type docs). */
function requireConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReportError('MISSING_FIELD', 'self_assessed_confidence is required');
  }
  return clamp01(value);
}

/**
 * Validated store for §14 management reports.
 *
 * submitReport() enforces, in order: schema version, required fields,
 * report_id uniqueness, per-task sequence monotonicity (stale/duplicate
 * sequences are rejected and never overwrite newer facts), ref existence,
 * actor-from-auth override, and system-field injection with freezing.
 */
export class ReportLog {
  private readonly reports = new Map<string, ManagementReport>();
  /** task_id -> highest accepted report_sequence. */
  private readonly lastSequence = new Map<string, number>();

  /**
   * Validate and store a report. Returns the stored report (a defensive
   * copy; its `system` object is frozen). Throws ReportError on any
   * validation failure — nothing is stored on failure.
   */
  submitReport(input: NewManagementReport, ctx: ReportSubmitContext): ManagementReport {
    if (input.schema_version !== REPORT_SCHEMA_VERSION) {
      throw new ReportError(
        'INVALID_SCHEMA',
        `schema_version must be "${REPORT_SCHEMA_VERSION}"`,
      );
    }
    const report_id = nonEmpty(input.report_id, 'report_id');
    const task_id = nonEmpty(input.task_id, 'task_id');
    const requirement_version = nonEmpty(input.requirement_version, 'requirement_version');
    const run_id = nonEmpty(input.run_id, 'run_id');
    const recommended_next_action = nonEmpty(input.recommended_next_action, 'recommended_next_action');

    if (typeof input.report_sequence !== 'number' || !Number.isInteger(input.report_sequence)) {
      throw new ReportError('INVALID_SCHEMA', 'report_sequence must be an integer');
    }
    if (!STATUSES.includes(input.status)) {
      throw new ReportError(
        'INVALID_SCHEMA',
        `status must be one of ${STATUSES.join('|')}`,
      );
    }

    // Duplicate report ids are never re-stored.
    if (this.reports.has(report_id)) {
      throw new ReportError('DUPLICATE_REPORT', `report ${report_id} was already submitted`);
    }

    // Sequence must strictly increase per task: repeated or old sequence
    // numbers are rejected and must not regress over newer facts.
    const last = this.lastSequence.get(task_id);
    if (last !== undefined && input.report_sequence <= last) {
      throw new ReportError(
        'STALE_SEQUENCE',
        `report_sequence ${input.report_sequence} is not newer than ${last} for task ${task_id}; ` +
          `stale reports never overwrite newer facts`,
      );
    }

    const artifact_refs = strArray(input.artifact_refs, 'artifact_refs');
    const evidence_refs = strArray(input.evidence_refs, 'evidence_refs');
    for (const id of artifact_refs) {
      if (!ctx.refs.artifactExists(id)) {
        throw new ReportError('UNKNOWN_ARTIFACT_REF', `artifact ref ${id} does not exist`);
      }
    }
    for (const id of evidence_refs) {
      if (!ctx.refs.evidenceExists(id)) {
        throw new ReportError('UNKNOWN_EVIDENCE_REF', `evidence ref ${id} does not exist`);
      }
    }

    const risks: ReportRisk[] = Array.isArray(input.risks)
      ? input.risks.map((r) => {
          if (
            typeof r !== 'object' ||
            r === null ||
            !SEVERITIES.includes((r as { severity?: RiskSeverity }).severity as RiskSeverity) ||
            typeof (r as { description?: unknown }).description !== 'string'
          ) {
            throw new ReportError('INVALID_SCHEMA', 'each risk needs a valid severity and description');
          }
          const rr = r as ReportRisk;
          return { severity: rr.severity, description: rr.description };
        })
      : [];

    // Actor comes from the authenticated context — never from the payload.
    const employee_id = nonEmpty(ctx.actor, 'ctx.actor');

    // System fields are injected by the caller; anything smuggled in the
    // input is ignored. The attached object is frozen: read-only.
    const system: SystemReportFields = Object.freeze({
      progress_snapshot_id: nonEmpty(ctx.system.progress_snapshot_id, 'ctx.system.progress_snapshot_id'),
      computed_progress: clamp01(ctx.system.computed_progress),
      computed_at: ctx.system.computed_at,
      current_gate: nonEmpty(ctx.system.current_gate, 'ctx.system.current_gate'),
    });

    const report: ManagementReport = {
      schema_version: REPORT_SCHEMA_VERSION,
      report_id,
      task_id,
      requirement_version,
      employee_id,
      run_id,
      report_sequence: input.report_sequence,
      status: input.status,
      work_completed: strArray(input.work_completed, 'work_completed'),
      artifact_refs,
      evidence_refs,
      risks,
      blockers: strArray(input.blockers, 'blockers'),
      decisions_needed: strArray(input.decisions_needed, 'decisions_needed'),
      recommended_next_action,
      // Subjective only — stored as reported, never used as a gate score.
      self_assessed_confidence: requireConfidence(input.self_assessed_confidence),
      system,
    };

    this.reports.set(report_id, report);
    this.lastSequence.set(task_id, input.report_sequence);
    return { ...report };
  }

  /** Fetch one report by id. */
  get(reportId: string): ManagementReport | undefined {
    const r = this.reports.get(reportId);
    return r ? { ...r } : undefined;
  }

  /**
   * Decide a submitted report (§14 manager review).
   * Only SUBMITTED_FOR_REVIEW reports can be decided; the decision is
   * ACCEPTED | REJECTED | ESCALATED. Deciding is idempotent-safe in the
   * sense that a second decide on a non-pending report throws
   * ReportError('NOT_SUBMITTED') — no silent re-decision.
   */
  decideReport(
    reportId: string,
    decision: 'ACCEPTED' | 'REJECTED' | 'ESCALATED',
    decidedBy: string,
  ): ManagementReport {
    const r = this.reports.get(reportId);
    if (!r) throw new ReportError('UNKNOWN_REPORT', `report ${reportId} does not exist`);
    if (r.status !== 'SUBMITTED_FOR_REVIEW') {
      throw new ReportError(
        'NOT_SUBMITTED',
        `report ${reportId} is ${r.status}, not SUBMITTED_FOR_REVIEW — cannot decide`,
      );
    }
    if (!['ACCEPTED', 'REJECTED', 'ESCALATED'].includes(decision)) {
      throw new ReportError('INVALID_DECISION', `decision must be ACCEPTED | REJECTED | ESCALATED`);
    }
    const by = (decidedBy ?? '').trim();
    if (!by) throw new ReportError('INVALID_SCHEMA', 'decidedBy is required');
    const updated: ManagementReport = { ...r, status: decision };
    this.reports.set(reportId, updated);
    return { ...updated };
  }

  /** All reports for one task, in sequence order. */
  listByTask(taskId: string): ManagementReport[] {
    return [...this.reports.values()]
      .filter((r) => r.task_id === taskId)
      .sort((a, b) => a.report_sequence - b.report_sequence)
      .map((r) => ({ ...r }));
  }

  /** The newest accepted report for a task (stale submissions never replaced it). */
  latestForTask(taskId: string): ManagementReport | undefined {
    const list = this.listByTask(taskId);
    return list.length ? list[list.length - 1] : undefined;
  }

  /**
   * Restart hydration (Batch 34): restore previously persisted reports
   * into a fresh ReportLog. Rows hydrate AS-IS — reports are historical
   * records, not executions, so a SUBMITTED_FOR_REVIEW row still means
   * "submitted, no decision recorded yet" after the restart (decisions
   * only ever flow through decideReport, which is also written
   * through, so no liveness claim needs demoting). The critical part
   * is rebuilding lastSequence: without it, a stale report could be
   * re-submitted after reboot, violating sequence monotonicity.
   *
   * The input is trusted as already-validated (it was validated on
   * submit); system objects are re-frozen to keep the read-only
   * guarantee. Malformed entries throw loudly — the caller skips
   * corrupt rows and audits them, never guessing.
   */
  loadSnapshot(reports: ManagementReport[]): void {
    this.reports.clear();
    this.lastSequence.clear();
    for (const r of reports) {
      if (typeof r.report_id !== 'string' || !r.report_id) {
        throw new Error('loadSnapshot: report without report_id');
      }
      this.reports.set(r.report_id, { ...r, system: Object.freeze({ ...r.system }) });
      const last = this.lastSequence.get(r.task_id);
      if (last === undefined || r.report_sequence > last) {
        this.lastSequence.set(r.task_id, r.report_sequence);
      }
    }
  }

  size(): number {
    return this.reports.size;
  }
}
