/**
 * Evaluation routes — spec §45 (Evaluation Engine, Improvement Loop, Self-improvement).
 *
 *   POST /api/evaluations                 {taskId, agentId, summary, evidenceIds, success, tests, ...}
 *   GET  /api/evaluations?taskId=         list (optionally filtered)
 *   GET  /api/evaluations/:id
 *   GET  /api/profiles/:agentId           agent profile (incremental)
 *   GET  /api/profiles                    leaderboard
 *   POST /api/proposals                   {kind, title, description, proposedBy, criticalOrgRule?, lessonIds?, targetDomains?}
 *                                         → 403 {code: LOCKED_DOMAIN} when the proposal
 *                                           touches a locked domain (at creation)
 *   GET  /api/proposals?status=
 *   POST /api/proposals/locked-demo       {title, description, proposedBy?, targetDomains?}
 *                                         → demonstrates the locked-domain rejection
 *   POST /api/proposals/:id/approve       {approver}
 *   POST /api/proposals/:id/reject        {approver, reason?}
 *   POST /api/proposals/:id/apply
 *   POST /api/loops                       {taskId, verifiedBy} → start an improvement loop
 *   GET  /api/loops/:id                   loop status + admission-check trail
 *   POST /api/loops/:id/advance           {step, ...} advance one loop stage
 *
 * Locked domains (lock rules, human authority, permission ceilings, access
 * control, gate standards) are rejected at proposal creation — before any
 * approval step and regardless of the approver [§45.2].
 * Improvement proposals can only be APPLIED after approval (§45.2): unapproved
 * APPLY attempts are rejected. Every evaluation/proposal/loop decision writes
 * an audit record.
 *
 * The coordinator wires this in: handleEvaluationRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: stores are in-memory (lost on restart).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EvaluationEngine,
  AgentProfiler,
  ProposalBoard,
  ImprovementLoop,
  LockedDomainError,
  type EvaluationResult,
  type EvaluationRun,
  type Lesson,
  type NewProposal,
  type TaskEvaluationInput,
} from '@ai-factory/evaluation';
import type { RouteContext } from './context';

const PREFIX = '/api/evaluations';
const PROPOSAL_PREFIX = '/api/proposals';
const LOOP_PREFIX = '/api/loops';

const engine = new EvaluationEngine();
const profiler = new AgentProfiler();
const board = new ProposalBoard();
const loops = new ImprovementLoop();
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
    path === PROPOSAL_PREFIX || path.startsWith(PROPOSAL_PREFIX + '/') ||
    path === LOOP_PREFIX || path.startsWith(LOOP_PREFIX + '/');
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
        targetDomains: Array.isArray(body['targetDomains']) ? (body['targetDomains'] as string[]) : undefined,
      });
      ctx.audit.record(proposedBy, 'IMPROVEMENT_PROPOSED', 'proposal', p.proposalId, { kind, title });
      return ctx.json(res, 201, { proposal: p }), true;
    } catch (e) {
      // Locked domains are rejected at creation (§45.2), before any approval.
      if (e instanceof LockedDomainError) {
        return ctx.json(res, 403, { error: e.message, code: e.code, domain: e.domain }), true;
      }
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // POST /api/proposals/locked-demo — demonstrates the locked-domain
  // rejection without touching real proposals. Returns 403 {code:
  // LOCKED_DOMAIN} when the text/domains hit a locked domain.
  if (method === 'POST' && path === `${PROPOSAL_PREFIX}/locked-demo`) {
    const body = await ctx.readBody(req);
    const title = typeof body['title'] === 'string' ? body['title'] : '';
    const description = typeof body['description'] === 'string' ? body['description'] : '';
    const proposedBy = typeof body['proposedBy'] === 'string' ? body['proposedBy'] : 'demo';
    const targetDomains = Array.isArray(body['targetDomains']) ? (body['targetDomains'] as string[]) : undefined;
    try {
      board.propose({ kind: 'org-rule', title, description, proposedBy, targetDomains });
      return ctx.json(res, 200, { rejected: false, note: 'proposal accepted — no locked domain touched' }), true;
    } catch (e) {
      if (e instanceof LockedDomainError) {
        ctx.audit.record(proposedBy, 'LOCKED_DOMAIN_REJECTED', 'proposal', 'locked-demo', {
          domain: e.domain, title,
        });
        return ctx.json(res, 403, { rejected: true, error: e.message, code: e.code, domain: e.domain }), true;
      }
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

  // ---- improvement loops -------------------------------------------------
  // POST /api/loops — start a loop from a verified task.
  if (method === 'POST' && path === LOOP_PREFIX) {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'];
    const verifiedBy = typeof body['verifiedBy'] === 'string' ? body['verifiedBy'] : 'human';
    if (typeof taskId !== 'string') {
      return ctx.json(res, 400, { error: 'taskId is required' }), true;
    }
    const c = loops.start(taskId, {
      verifiedBy,
      evidenceIds: Array.isArray(body['evidenceIds']) ? (body['evidenceIds'] as string[]) : [],
    });
    ctx.audit.record(verifiedBy, 'IMPROVEMENT_LOOP_STARTED', 'loop', c.caseId, { taskId });
    return ctx.json(res, 201, { loop: c }), true;
  }

  const loopMatch = path.match(/^\/api\/loops\/([^/]+)(\/.*)?$/);
  if (loopMatch) {
    const id = decodeURIComponent(loopMatch[1]);
    const rest = loopMatch[2] ?? '';

    // GET /api/loops/:id — status + admission-check trail.
    if (method === 'GET' && rest === '') {
      try {
        return ctx.json(res, 200, { loop: loops.status(id) }), true;
      } catch {
        return ctx.json(res, 404, { error: `loop case not found: ${id}` }), true;
      }
    }

    // POST /api/loops/:id/advance — {step, ...payload} advances one stage.
    if (method === 'POST' && rest === '/advance') {
      const body = await ctx.readBody(req);
      const step = body['step'];
      const by = typeof body['by'] === 'string' ? body['by'] : 'human';
      try {
        let c;
        switch (step) {
          case 'outcome_eval':
            c = loops.recordOutcomeEval(id, body['evaluation'] as EvaluationResult, by);
            break;
          case 'lesson':
            c = loops.addLesson(id, body['lesson'] as Lesson, by);
            break;
          case 'proposal':
            c = loops.fileProposal(id, {
              kind: body['kind'] as NewProposal['kind'],
              title: body['title'] as string,
              description: typeof body['description'] === 'string' ? body['description'] : '',
              proposedBy: by,
              targetDomains: Array.isArray(body['targetDomains']) ? (body['targetDomains'] as string[]) : undefined,
            });
            break;
          case 'independent_eval':
            c = loops.runIndependentEval(id, {
              regression: body['regression'] as EvaluationRun,
              security: body['security'] as EvaluationRun,
              by,
            });
            break;
          case 'version':
            c = loops.versionProposal(id, body['version'] as string, by);
            break;
          case 'approve':
            c = loops.approvePolicy(id, typeof body['approver'] === 'string' ? body['approver'] : by);
            break;
          case 'activate':
            c = loops.activateLimited(id, {
              employees: Array.isArray(body['employees']) ? (body['employees'] as string[]) : [],
              note: typeof body['note'] === 'string' ? body['note'] : '',
              by,
            });
            break;
          case 'observe':
            c = loops.observe(id, {
              note: typeof body['note'] === 'string' ? body['note'] : '',
              success: body['success'] === true,
              by,
            });
            break;
          case 'promote':
            c = loops.promote(id, by);
            break;
          case 'revert':
            c = loops.revert(id, {
              by,
              reason: typeof body['reason'] === 'string' ? body['reason'] : '',
            });
            break;
          default:
            return ctx.json(res, 400, { error: `unknown loop step: ${String(step)}` }), true;
        }
        ctx.audit.record(by, 'IMPROVEMENT_LOOP_ADVANCED', 'loop', id, { step, stage: c.stage });
        return ctx.json(res, 200, { loop: c }), true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        const status = code === 'LOCKED_DOMAIN' ? 403 : 422;
        return ctx.json(res, status, { error: (e as Error).message, ...(code ? { code } : {}) }), true;
      }
    }
  }

  return false;
}
