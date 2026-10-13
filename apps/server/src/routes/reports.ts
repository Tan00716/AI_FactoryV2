/**
 * Management report routes — SPEC_V2 §14 (lives in @ai-factory/comms).
 *
 *  POST /api/reports/submit              submit a management report
 *  POST /api/reports/decide              decide a submitted report (ACCEPTED | REJECTED | ESCALATED)
 *  GET  /api/reports/:id                 fetch one report
 *  GET  /api/reports?task_id=...         list reports for a task
 *
 * Actor identity comes from the `x-actor` header (falls back to the body
 * `actor` field, then 'api'); the domain layer overrides employee_id from
 * this trusted context — forged values in the payload are ignored.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  REPORT_SCHEMA_VERSION,
  ReportError,
  ReportLog,
  type ManagementReport,
  type NewManagementReport,
  type ReportSubmitContext,
} from '@ai-factory/comms';
import type { FactoryDatabase } from '@ai-factory/db';
import type { AuditLog } from '@ai-factory/core';
import type { RouteContext } from './context';

const log = new ReportLog();

/** Set by initReportsPersistence at boot; null on read failure (memory-only). */
let fdb: FactoryDatabase | null = null;

function toDbRecord(report: ManagementReport, createdAt: number) {
  return {
    reportId: report.report_id,
    taskId: report.task_id,
    reportSequence: report.report_sequence,
    status: report.status,
    reportJson: JSON.stringify(report),
    createdAt,
  };
}

function auditError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Management-report durability (§14, §48.2, Batch 34): every submit
 * and every decision is written through to fdb.managementReports the
 * moment it happens. A write failure audits REPORT_PERSIST_FAILED /
 * REPORT_DECISION_PERSIST_FAILED loudly but does not roll back the
 * response (the report is already in the live log — the same
 * "persist failure never un-happens the outcome" pattern as Batch 33
 * escalations).
 *
 * Restart semantics (Batch 34 determination): rows hydrate AS-IS.
 * SUBMITTED_FOR_REVIEW is a pending-decision record, not a live
 * execution — it means "submitted, no decision recorded yet", which
 * stays exactly as true after the restart because decisions only
 * ever flow through ReportLog.decideReport (also written through).
 * The one thing rebuilt is the per-task sequence monotonicity guard
 * (ReportLog.loadSnapshot), or stale reports could be re-submitted
 * after reboot. Corrupt rows are skipped loudly (REPORT_ROW_CORRUPT),
 * never guessed.
 */
export function initReportsPersistence(db: FactoryDatabase, audit: AuditLog): void {
  fdb = db;
  const valid: ManagementReport[] = [];
  try {
    for (const row of db.managementReports.listReports()) {
      try {
        const parsed = JSON.parse(row.reportJson) as ManagementReport;
        if (typeof parsed.report_id !== 'string' || !parsed.report_id) {
          throw new Error('row without report_id');
        }
        valid.push(parsed);
      } catch (e) {
        // Corrupt rows fail loudly: one bad row never hides the rest.
        audit.record('system', 'REPORT_ROW_CORRUPT', 'report', row.reportId, {
          error: auditError(e),
        });
      }
    }
  } catch (e) {
    // A read failure is an honest boot condition, not a silent one:
    // the live log works, persisted history is unavailable.
    audit.record('system', 'REPORT_HYDRATE_FAILED', 'report', '(all)', {
      error: auditError(e),
    });
    return;
  }
  try {
    log.loadSnapshot(valid);
  } catch (e) {
    audit.record('system', 'REPORT_HYDRATE_FAILED', 'report', '(all)', {
      error: auditError(e),
    });
  }
}

/** Route-local submit context: server-owned actor + system fields. */
function submitContext(req: IncomingMessage, body: Record<string, unknown>): ReportSubmitContext {
  const headerActor = req.headers['x-actor'];
  const actor =
    (typeof headerActor === 'string' && headerActor.trim()) ||
    (typeof body['actor'] === 'string' && (body['actor'] as string).trim()) ||
    'api';
  return {
    actor,
    system: {
      progress_snapshot_id: `snap:${Date.now()}`,
      computed_progress: 0,
      computed_at: Date.now(),
      current_gate: 'NONE',
    },
    // Server has no artifact/evidence store wired here: refs must be empty.
    // Any non-empty ref list is rejected with UNKNOWN_*_REF.
    refs: {
      artifactExists: () => false,
      evidenceExists: () => false,
    },
  };
}

export async function handleReportRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/reports')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/reports'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'submit') {
    const body = await ctx.readBody(req);
    try {
      const report = log.submitReport(body as NewManagementReport, submitContext(req, body));
      ctx.audit.record('api', 'REPORT_SUBMITTED', 'report', report.report_id, {
        task_id: report.task_id,
      });
      if (fdb !== null) {
        try {
          fdb.managementReports.saveReport(toDbRecord(report, Date.now()));
        } catch (e) {
          ctx.audit.record('api', 'REPORT_PERSIST_FAILED', 'report', report.report_id, {
            error: auditError(e),
          });
        }
      }
      ctx.json(res, 201, { report });
    } catch (err) {
      const code = err instanceof ReportError ? err.code : 'INVALID_SCHEMA';
      ctx.json(res, 400, { error: (err as Error).message, code });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'decide') {
    const body = await ctx.readBody(req);
    const reportId = body['report_id'];
    const decision = body['decision'];
    const headerActor = req.headers['x-actor'];
    const decidedBy =
      (typeof headerActor === 'string' && headerActor.trim()) ||
      (typeof body['decided_by'] === 'string' && (body['decided_by'] as string).trim()) ||
      'api';
    if (typeof reportId !== 'string' || !reportId) {
      ctx.json(res, 400, { error: 'report_id is required' });
      return true;
    }
    try {
      const report = log.decideReport(reportId, decision as 'ACCEPTED' | 'REJECTED' | 'ESCALATED', decidedBy);
      ctx.audit.record('api', 'REPORT_DECIDED', 'report', report.report_id, {
        decision: report.status,
        decided_by: decidedBy,
      });
      if (fdb !== null) {
        try {
          const flipped = fdb.managementReports.updateReport(toDbRecord(report, Date.now()));
          if (!flipped) {
            ctx.audit.record('api', 'REPORT_DECISION_PERSIST_FAILED', 'report', report.report_id, {
              reason: 'row missing or no longer SUBMITTED_FOR_REVIEW',
            });
          }
        } catch (e) {
          ctx.audit.record('api', 'REPORT_DECISION_PERSIST_FAILED', 'report', report.report_id, {
            error: auditError(e),
          });
        }
      }
      ctx.json(res, 200, { report });
    } catch (err) {
      const code = err instanceof ReportError ? err.code : 'INVALID_SCHEMA';
      ctx.json(res, 400, { error: (err as Error).message, code });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1) {
    const report = log.get(seg[0]);
    if (!report) {
      ctx.json(res, 404, { error: `report ${seg[0]} not found` });
      return true;
    }
    ctx.json(res, 200, { report });
    return true;
  }

  if (method === 'GET' && seg.length === 0) {
    const taskId = url.searchParams.get('task_id');
    const reports = taskId ? log.listByTask(taskId) : [];
    ctx.json(res, 200, { reports, schema_version: REPORT_SCHEMA_VERSION });
    return true;
  }

  return false;
}
