/**
 * Code Review routes — spec §35 review engine, §12 gate evidence,
 * §37 review independence (Batch 5).
 *
 *  GET  /api/review/dimensions  the 10 review dimensions
 *  POST /api/review             {files, diff?, projectConventions?, taskId?, actor?,
 *                                reviewerId, reviewerRunId, implementerId,
 *                                implementerRunId, highRisk?,
 *                                reviewerRuntimeId?, implementerRuntimeId?,
 *                                gateStoreWritableByImplementer?,
 *                                collectorWritableByImplementer?}
 *                               → {verdict, findings, summary, meetsGate, evidenceId}
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleReviewRoutes } from './routes/review';
 *   if (await handleReviewRoutes(req, res, url, ctx)) return;
 *
 * §37: the review runs through reviewWithIndependence() — the identity
 * quadruple (reviewerId / reviewerRunId / implementerId / implementerRunId)
 * is REQUIRED. Missing identity → 400 (fail-closed, never a default pass);
 * a failed independence precondition (self-review, same Run, implementer
 * can write the Gate Store / Evidence Collector, high-risk same-runtime)
 * → 422 with reasonCode INDEPENDENCE_REQUIRED and the failed checks.
 * The gate/collector writability flags default to false because both
 * stores are server-owned in this deployment; a caller declaring true is
 * denied like any other failed check. The sealed evidence and the audit
 * record name the reviewer, so the gate record shows who reviewed.
 *
 * When a taskId naming an existing task is supplied, the review is sealed
 * as §12 gate evidence (type 'code_review') and audit-logged, exactly like
 * the QA route seals 'qa_result' evidence.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  ALL_DIMENSIONS,
  IndependenceRequiredError,
  meetsGate,
  reviewGateEvidence,
  reviewWithIndependence,
} from '@ai-factory/review';
import type {
  IndependenceContext,
  ReviewFile,
  ReviewInput,
} from '@ai-factory/review';
import type { RouteContext } from './context';

export async function handleReviewRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/review')) return false;
  const method = req.method ?? 'GET';
  const rest = path.slice('/api/review'.length);

  // GET /api/review/dimensions
  if (method === 'GET' && rest === '/dimensions') {
    ctx.json(res, 200, { dimensions: ALL_DIMENSIONS });
    return true;
  }

  // POST /api/review  {files, diff?, projectConventions?, taskId?, actor?}
  if (method === 'POST' && (rest === '' || rest === '/')) {
    const body = await ctx.readBody(req);
    const files = body['files'] as unknown;
    const actor = (body['actor'] as string | undefined) ?? 'human';

    if (!Array.isArray(files)) {
      ctx.json(res, 400, {
        error: 'files is required: array of {path, before?, after?}',
      });
      return true;
    }
    for (const f of files) {
      if (!f || typeof (f as ReviewFile).path !== 'string') {
        ctx.json(res, 400, { error: 'every file must have a string path' });
        return true;
      }
    }

    const input: ReviewInput = {
      files: files as ReviewFile[],
      diff: typeof body['diff'] === 'string' ? (body['diff'] as string) : undefined,
      projectConventions: Array.isArray(body['projectConventions'])
        ? (body['projectConventions'] as unknown[]).filter(
            (c): c is string => typeof c === 'string',
          )
        : undefined,
    };

    // §37 independence identity — required, fail-closed. Field names match
    // IndependenceContext in @ai-factory/review exactly.
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const independence: IndependenceContext = {
      reviewerId: str(body['reviewerId']),
      reviewerRunId: str(body['reviewerRunId']),
      implementerId: str(body['implementerId']),
      implementerRunId: str(body['implementerRunId']),
      gateStoreWritableByImplementer: body['gateStoreWritableByImplementer'] === true,
      collectorWritableByImplementer: body['collectorWritableByImplementer'] === true,
      highRisk: body['highRisk'] === true ? true : undefined,
      reviewerRuntimeId: str(body['reviewerRuntimeId']) || undefined,
      implementerRuntimeId: str(body['implementerRuntimeId']) || undefined,
    };
    const missingIdentity = (
      ['reviewerId', 'reviewerRunId', 'implementerId', 'implementerRunId'] as const
    ).filter((k) => !independence[k]);
    if (missingIdentity.length > 0) {
      ctx.json(res, 400, {
        error:
          'review identity is required (§37 independence): missing ' +
          missingIdentity.join(', '),
      });
      return true;
    }

    const taskId = body['taskId'] as string | undefined;
    // Batch 14 — a task-bound review seals gate evidence onto the task:
    // a new fact under the task's project, refused while archived
    // (before the review runs, so no audit/evidence/notification side
    // effects). A review with no taskId writes nothing project-scoped
    // and stays unguarded. The decision is the coordinator-injected
    // guard (ctx.archivedTaskBody, backed by routes/project-guard.ts —
    // see context.ts for why this module does not import it directly).
    if (typeof taskId === 'string' && taskId) {
      const archivedBody = ctx.archivedTaskBody?.(taskId);
      if (archivedBody) {
        ctx.json(res, 409, archivedBody);
        return true;
      }
    }
    let result;
    try {
      result = reviewWithIndependence(input, independence);
    } catch (err) {
      if (err instanceof IndependenceRequiredError) {
        // Gate precondition failed — the review never ran. Audit the denial
        // (evidence the gate stayed closed) and answer 422 with the §49
        // reason code, matching this server's gate-denial style.
        ctx.audit.record(actor, 'CODE_REVIEW_INDEPENDENCE_DENIED', 'code_review', taskId ?? 'review', {
          taskId: taskId ?? null,
          reviewerId: independence.reviewerId,
          implementerId: independence.implementerId,
          reasonCode: err.code,
          failedChecks: err.failedChecks,
        });
        ctx.json(res, 422, {
          error: err.message,
          reasonCode: err.code,
          failedChecks: err.failedChecks,
        });
        return true;
      }
      ctx.json(res, 400, { error: (err as Error).message });
      return true;
    }

    const gate = meetsGate(result.verdict);
    let evidenceId: string | null = null;
    if (taskId && ctx.tasks.get(taskId)) {
      const evidence = ctx.evidence.create({
        taskId,
        type: 'code_review',
        title: `Code review — ${result.verdict}`,
        payload: {
          ...(reviewGateEvidence(result) as unknown as Record<string, unknown>),
          reviewerId: independence.reviewerId,
          implementerId: independence.implementerId,
          reviewerRunId: independence.reviewerRunId,
          implementerRunId: independence.implementerRunId,
        },
        createdBy: actor,
      });
      evidenceId = evidence.id;
      ctx.audit.record(actor, 'CODE_REVIEW_COMPLETED', 'code_review', evidenceId, {
        taskId,
        verdict: result.verdict,
        findings: result.summary.total,
        meetsGate: gate,
        reviewerId: independence.reviewerId,
        implementerId: independence.implementerId,
      });
    }

    ctx.json(res, 200, {
      verdict: result.verdict,
      findings: result.findings,
      summary: result.summary,
      meetsGate: gate,
      evidenceId,
    });
    // Notification trigger (module 30): a failed quality gate pings the
    // human with a HIGH-priority in-app notification.
    if (!gate) {
      ctx.notify.emit({
        type: 'GATE_FAILED',
        actor,
        entity: { kind: 'review', id: evidenceId ?? 'review', label: taskId ?? result.verdict },
        detail: { reason: `${result.summary.blocker} blocking findings`, taskId },
      });
    }
    return true;
  }

  return false;
}
