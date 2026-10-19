/**
 * Session worktree routes — git worktree session isolation (task 3).
 *
 *   GET    /api/session-worktrees          list (branch/head/path per worktree)
 *   POST   /api/session-worktrees          {projectPath, name, sessionId?} → 201
 *   DELETE /api/session-worktrees/:id      remove (working tree only — never branches)
 *   POST   /api/session-worktrees/prune    drop stale records (path gone / unregistered)
 *
 * Session binding lives in routes/sessions.ts:
 *   POST   /api/sessions/:id/worktree      {worktreeId} → bind
 *   DELETE /api/sessions/:id/worktree      unbind
 * A bound session makes POST /api/exec {sessionId} (no cwd) and session
 * checkpoints default to the worktree path.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET →
 * viewer and POST/DELETE → operator for this prefix — no auth.ts change.
 * Every mutation is audited as WORKTREE_CREATED / WORKTREE_REMOVED /
 * WORKTREE_PRUNED (actor 'human' unless the body names one).
 *
 * This does NOT overlap the Batch-19 task-scoped /api/worktrees API
 * (routes/worktrees.ts, SPEC v2 §22.1): that one allocates branch
 * worktrees per (repoPath, taskId) through the Git Broker; this one is
 * session-scoped detached worktrees for parallel session isolation.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  WorktreeError,
  sessionWorktrees,
  worktreeErrorStatus,
  type SessionWorktreeInfo,
} from '../worktrees';

const PREFIX = '/api/session-worktrees';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

function shape(w: SessionWorktreeInfo): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    projectPath: w.projectPath,
    worktreePath: w.worktreePath,
    sessionId: w.sessionId,
    branch: w.branch,
    head: w.head,
    registered: w.registered,
    createdBy: w.createdBy,
    createdAt: w.createdAt,
  };
}

function errBody(e: unknown): Record<string, unknown> {
  if (e instanceof WorktreeError) return { error: e.code, message: e.message };
  return { error: 'WORKTREE_FAILED', message: (e as Error).message ?? 'unknown' };
}

export async function handleSessionWorktreeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const rest = path.slice(PREFIX.length);

  // GET /api/session-worktrees → list.
  if (rest === '' && method === 'GET') {
    try {
      const list = sessionWorktrees().listWorktrees();
      return ctx.json(res, 200, { worktrees: list.map(shape) }), true;
    } catch (e) {
      return ctx.json(res, worktreeErrorStatus(e), errBody(e)), true;
    }
  }

  // POST /api/session-worktrees → create.
  if (rest === '' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectPath = str(body['projectPath']);
    const name = str(body['name']);
    if (!projectPath || !name) {
      return ctx.json(res, 400, { error: 'BAD_REQUEST', message: 'projectPath and name are required' }), true;
    }
    try {
      const { record, includeCopied, includeSkipped } = sessionWorktrees().createWorktree(projectPath, name, {
        sessionId: str(body['sessionId']) ?? undefined,
        createdBy: actorOf(body),
      });
      ctx.audit.record(actorOf(body), 'WORKTREE_CREATED', 'session-worktree', record.id, {
        name: record.name,
        projectPath: record.projectPath,
        worktreePath: record.worktreePath,
        sessionId: record.sessionId,
        includeCopied,
        includeSkipped,
      });
      const info = sessionWorktrees().listWorktrees().find((w) => w.id === record.id);
      return ctx.json(res, 201, { worktree: info ? shape(info) : record, includeCopied, includeSkipped }), true;
    } catch (e) {
      return ctx.json(res, worktreeErrorStatus(e), errBody(e)), true;
    }
  }

  // POST /api/session-worktrees/prune → drop stale records.
  if (rest === '/prune' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const pruned = sessionWorktrees().pruneStale();
      if (pruned.length > 0) {
        ctx.audit.record(actorOf(body), 'WORKTREE_PRUNED', 'session-worktree', pruned.join(','), {
          pruned,
        });
      }
      return ctx.json(res, 200, { pruned }), true;
    } catch (e) {
      return ctx.json(res, worktreeErrorStatus(e), errBody(e)), true;
    }
  }

  // DELETE /api/session-worktrees/:id → remove.
  const m = rest.match(/^\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const removed = sessionWorktrees().removeWorktree(m[1]);
      ctx.audit.record(actorOf(body), 'WORKTREE_REMOVED', 'session-worktree', removed.id, {
        name: removed.name,
        worktreePath: removed.worktreePath,
      });
      return ctx.json(res, 200, { removed: removed.id }), true;
    } catch (e) {
      return ctx.json(res, worktreeErrorStatus(e), errBody(e)), true;
    }
  }

  return ctx.json(res, 404, { error: 'NOT_FOUND' }), true;
}
