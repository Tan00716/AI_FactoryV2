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
  type NewManagementReport,
  type ReportSubmitContext,
} from '@ai-factory/comms';
import type { RouteContext } from './context';

const log = new ReportLog();

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
