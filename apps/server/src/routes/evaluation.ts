/**
 * Evaluation routes — spec §57 (Evaluation Engine), §58 (Agent Improvement).
 *
 *   POST /api/evaluations                 {taskId, agentId, summary, evidenceIds, success, tests, ...}
 *   GET  /api/evaluations?taskId=         list (optionally filtered)
 *   GET  /api/evaluations/:id
 *   GET  /api/profiles/:agentId           agent profile (incremental)
 *   GET  /api/profiles                    leaderboard
 *   POST /api/proposals                   {kind, title, description, proposedBy, criticalOrgRule?, lessonIds?}
 *   GET  /api/proposals?status=
 *   POST /api/proposals/:id/approve       {approver}
 *   POST /api/proposals/:id/reject        {approver, reason?}
 *   POST /api/proposals/:id/apply
 *
 * Improvement proposals can only be APPLIED after approval (§58): unapproved
 * APPLY attempts are rejected, and critical org-rule kinds cannot be
 * self-approved by agents. Every evaluation/proposal decision writes an
 * audit record.
 *
 * The coordinator wires this in: handleEvaluationRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: stores are in-memory (lost on restart).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EvaluationEngine,
  AgentProfiler,
  ProposalBoard,
  type NewProposal,
  type TaskEvaluationInput,
} from '@ai-factory/evaluation';
import type { RouteContext } from './context';

const PREFIX = '/api/evaluations';
const PROPOSAL_PREFIX = '/api/proposals';

const engine = new EvaluationEngine();
const profiler = new AgentProfiler();
const board = new ProposalBoard();
/** Route-level index (EvaluationEngine has no list-all). */
const evaluationIndex: { evaluationId: string; taskId: string }[] = [];

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function handleEvaluationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const inScope =
    path === PREFIX || path.startsWith(PREFIX + '/') ||
    path === PROPOSAL_PREFIX || path.startsWith(PROPOSAL_PREFIX + '/');
  if (!inScope) return false;

  // ---- evaluations ------------------------------------------------------
  // POST /api/evaluations
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'];
    const agentId = body['agentId'];
    if (typeof taskId !== 'string' || typeof agentId !== 'string') {
      return ctx.json(res, 400, { error: 'taskId and agentId are required' }), true;
    }
    const tests = body['tests'] as { passed?: number; total?: number } | undefined;
    const input: TaskEvaluationInput = {
      taskId,
      agentId,
      summary: typeof body['summary'] === 'string' ? body['summary'] : '',
      evidenceIds: Array.isArray(body['evidenceIds']) ? (body['evidenceIds'] as string[]) : [],
      success: body['success'] === true,
      tests: { passed: num(tests?.passed), total: num(tests?.total) },
      regressions: num(body['regressions']),
      reviewRounds: num(body['reviewRounds']),
      reviewRejections: num(body['reviewRejections']),
      fixLoops: num(body['fixLoops']),
      durationMs: num(body['durationMs']),
      tokensUsed: num(body['tokenUsage']),
      toolCalls: num(body['toolCalls']),
      toolErrors: num(body['toolErrors']),
      falseCompletions: body['falseCompletion'] === true ? 1 : 0,
      rollbacks: num(body['rollbacks']),
      escalations: num(body['humanEscalations']),
      completionClaims: 1,
      deployments: 0,
      decisions: 0,
    };
    const result = engine.evaluateTask(input);
    profiler.record(result);
    evaluationIndex.push({ evaluationId: result.evaluationId, taskId });
    ctx.audit.record(agentId, 'TASK_EVALUATED', 'evaluation', result.evaluationId, {
      taskId, verdict: result.verdict, score: result.score,
    });
    return ctx.json(res, 201, { evaluation: result }), true;
  }

  // GET /api/evaluations?taskId=
  if (method === 'GET' && path === PREFIX) {
    const taskId = url.searchParams.get('taskId');
    const ids = taskId
      ? evaluationIndex.filter((e) => e.taskId === taskId).map((e) => e.evaluationId)
      : evaluationIndex.map((e) => e.evaluationId);
    const list = ids
      .map((id) => engine.get(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined);
    return ctx.json(res, 200, { evaluations: list }), true;
  }

  const evalMatch = path.match(/^\/api\/evaluations\/([^/]+)$/);
  if (evalMatch && method === 'GET') {
    const e = engine.get(decodeURIComponent(evalMatch[1]));
    if (!e) return ctx.json(res, 404, { error: 'evaluation not found' }), true;
    return ctx.json(res, 200, { evaluation: e }), true;
  }

  // ---- agent profiles ----------------------------------------------------
  // GET /api/profiles (leaderboard) — before the :agentId matcher.
  if (method === 'GET' && path === '/api/profiles') {
    return ctx.json(res, 200, { profiles: profiler.leaderboard() }), true;
  }
  const profileMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch && method === 'GET') {
    const p = profiler.get(decodeURIComponent(profileMatch[1]));
    if (!p) return ctx.json(res, 404, { error: 'no evaluations recorded for this agent' }), true;
    return ctx.json(res, 200, { profile: p }), true;
  }

  // ---- improvement proposals ---------------------------------------------
  // POST /api/proposals
  if (method === 'POST' && path === PROPOSAL_PREFIX) {
    const body = await ctx.readBody(req);
    const kind = body['kind'];
    const title = body['title'];
    const proposedBy = body['proposedBy'];
    if (typeof kind !== 'string' || typeof title !== 'string' || typeof proposedBy !== 'string') {
      return ctx.json(res, 400, { error: 'kind, title and proposedBy are required' }), true;
    }
    try {
      const p = board.propose({
        kind: kind as NewProposal['kind'],
        title,
        description: typeof body['description'] === 'string' ? body['description'] : '',
        criticalOrgRule: body['criticalOrgRule'] === true,
        proposedBy,
        lessonIds: Array.isArray(body['lessonIds']) ? (body['lessonIds'] as string[]) : [],
      });
      ctx.audit.record(proposedBy, 'IMPROVEMENT_PROPOSED', 'proposal', p.proposalId, { kind, title });
      return ctx.json(res, 201, { proposal: p }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // GET /api/proposals?status=
  if (method === 'GET' && path === PROPOSAL_PREFIX) {
    const status = url.searchParams.get('status');
    const list = status ? board.all().filter((p) => p.status === status) : board.all();
    return ctx.json(res, 200, { proposals: list }), true;
  }

  const propMatch = path.match(/^\/api\/proposals\/([^/]+)(\/.*)?$/);
  if (propMatch) {
    const id = decodeURIComponent(propMatch[1]);
    const rest = propMatch[2] ?? '';
    if (method === 'GET' && rest === '') {
      const p = board.get(id);
      if (!p) return ctx.json(res, 404, { error: 'proposal not found' }), true;
      return ctx.json(res, 200, { proposal: p }), true;
    }
    const bodyOf = async () => ctx.readBody(req);
    if (method === 'POST' && rest === '/approve') {
      const b = await bodyOf();
      const approver = b['approver'];
      if (typeof approver !== 'string') return ctx.json(res, 400, { error: 'approver is required' }), true;
      try {
        const p = board.approve(id, approver);
        ctx.audit.record(approver, 'IMPROVEMENT_APPROVED', 'proposal', id, {});
        return ctx.json(res, 200, { proposal: p }), true;
      } catch (e) {
        return ctx.json(res, 422, { error: (e as Error).message }), true;
      }
    }
    if (method === 'POST' && rest === '/reject') {
      const b = await bodyOf();
      const approver = b['approver'];
      if (typeof approver !== 'string') return ctx.json(res, 400, { error: 'approver is required' }), true;
      try {
        const p = board.reject(id, approver, typeof b['reason'] === 'string' ? b['reason'] : undefined);
        ctx.audit.record(approver, 'IMPROVEMENT_REJECTED', 'proposal', id, {});
        return ctx.json(res, 200, { proposal: p }), true;
      } catch (e) {
        return ctx.json(res, 422, { error: (e as Error).message }), true;
      }
    }
    if (method === 'POST' && rest === '/apply') {
      try {
        const p = board.apply(id);
        ctx.audit.record('system', 'IMPROVEMENT_APPLIED', 'proposal', id, {});
        return ctx.json(res, 200, { proposal: p }), true;
      } catch (e) {
        return ctx.json(res, 422, { error: (e as Error).message }), true;
      }
    }
  }

  return false;
}
