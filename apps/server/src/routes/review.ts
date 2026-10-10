/**
 * Code Review routes — spec §35 review engine, §12 gate evidence.
 *
 *  GET  /api/review/dimensions  the 10 review dimensions
 *  POST /api/review             {files, diff?, projectConventions?, taskId?, actor?}
 *                               → {verdict, findings, summary, meetsGate, evidenceId}
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleReviewRoutes } from './routes/review';
 *   if (await handleReviewRoutes(req, res, url, ctx)) return;
 *
 * When a taskId naming an existing task is supplied, the review is sealed
 * as §12 gate evidence (type 'code_review') and audit-logged, exactly like
 * the QA route seals 'qa_result' evidence.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  ALL_DIMENSIONS,
  meetsGate,
  reviewCode,
  reviewGateEvidence,
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

    let result;
    try {
      result = reviewCode(input);
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
      return true;
    }

    const gate = meetsGate(result.verdict);
    let evidenceId: string | null = null;
    const taskId = body['taskId'] as string | undefined;
    if (taskId && ctx.tasks.get(taskId)) {
      const evidence = ctx.evidence.create({
        taskId,
        type: 'code_review',
        title: `Code review — ${result.verdict}`,
        payload: reviewGateEvidence(result) as unknown as Record<string, unknown>,
        createdBy: actor,
      });
      evidenceId = evidence.id;
      ctx.audit.record(actor, 'CODE_REVIEW_COMPLETED', 'code_review', evidenceId, {
        taskId,
        verdict: result.verdict,
        findings: result.summary.total,
        meetsGate: gate,
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
