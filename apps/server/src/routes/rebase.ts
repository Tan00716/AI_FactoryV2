/**
 * Interactive rebase + stash routes (round-6 task R6-S2).
 *
 *   GET  /api/rebase/todos?repo=&base=        commits in base..HEAD as pick lines (viewer)
 *   GET  /api/rebase/status?repo=             in-progress state + conflicted files (viewer)
 *   POST /api/rebase/start                    {repo, base, todos[]} (operator)
 *   POST /api/rebase/abort|continue|skip       {repo} (operator)
 *   POST /api/rebase/restore                  {repo, checkpointId} (operator)
 *   GET  /api/stash?repo=                     stash list (viewer)
 *   GET  /api/stash/show?repo=&index=         stash diff (viewer)
 *   POST /api/stash/push                      {repo, message, includeUntracked?} (operator)
 *   POST /api/stash/apply|pop|drop            {repo, index} (operator)
 *
 * Jail: repos are confined to the inspection root injected by the
 * coordinator (setter-injection pattern — routes must not value-import
 * ../inspections, AGENTS.md dual-mode rule). Git runs with cwd pinned
 * to the resolved repo via argv arrays (no shell).
 *
 * Safety: /api/rebase/start refuses a dirty tree and an already-running
 * rebase before any mutation, and takes a shadow checkpoint first
 * (fail-closed 503 when unavailable — same posture as merge3 resolve).
 * On hard rebase failure the package aborts back to the pre-rebase HEAD;
 * /api/rebase/restore additionally restores worktree files from the
 * shadow checkpoint. A conflicted state is left in place for the user
 * to resolve via the merge3 editor and then continue.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleRebaseRoutes, setRebaseInspectionRootResolver } from './routes/rebase';
 *   if (await handleRebaseRoutes(req, res, url, routeCtx)) return;
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Only porcelain-level operations. Semantic conflict resolution stays
 *    with the merge3 editor; this route never guesses a resolution.
 *  - No filter-branch / filter-repo history rewriting, ever.
 *  - Reword messages are single-line in v1; multi-line input is rejected.
 *  - A conflicted `stash pop` keeps the stash entry (git behavior) — the
 *    response says so explicitly so the stash is never silently lost.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { RouteContext } from './context';
import {
  abortRebase,
  applyStash,
  continueRebase,
  dropStash,
  headSha,
  isGitRepo,
  listConflicted,
  listStash,
  logRange,
  popStash,
  pushStash,
  readInProgressTodo,
  rebaseInProgress,
  resolveRef,
  showStash,
  skipRebase,
  startRebase,
  RebaseError,
  type TodoLine,
} from '@ai-factory/rebase';
import { createShadowCheckpoint, restoreShadowCheckpoint } from '../shadow-checkpoints';
import { shadowCheckpointStore } from './shadow';

const REBASE_PREFIX = '/api/rebase';
const STASH_PREFIX = '/api/stash';

let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setRebaseInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

export class RebaseRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'RebaseRouteError';
    this.code = code;
    this.status = status;
  }
}

function resolveRepo(rawRepo: unknown): string {
  if (!inspectionRootResolver) {
    throw new RebaseRouteError('inspection root resolver is not wired', 'not-wired', 503);
  }
  let repo: string;
  try {
    repo =
      typeof rawRepo === 'string' && rawRepo.trim()
        ? inspectionRootResolver(rawRepo.trim())
        : inspectionRootResolver(undefined);
  } catch (e) {
    throw new RebaseRouteError((e as Error).message, 'bad-repo', 403);
  }
  if (!existsSync(repo)) {
    throw new RebaseRouteError(`repo does not exist: ${repo}`, 'repo-not-found', 404);
  }
  if (!isGitRepo(repo)) {
    throw new RebaseRouteError(`not a git repository: ${repo}`, 'not-a-git-repo', 404);
  }
  return repo;
}

/** Stable shadow workspace id for a repo path (fits the id regex). */
function shadowWorkspaceId(repo: string): string {
  return `rebase-${createHash('sha256').update(repo).digest('hex').slice(0, 16)}`;
}

function parseTodos(raw: unknown): TodoLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RebaseRouteError('todos must be a non-empty array', 'bad-todos');
  }
  return raw.map((t, i) => {
    const o = t as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) {
      throw new RebaseRouteError(`todo ${i} is not an object`, 'bad-todos');
    }
    const action = o['action'];
    if (action !== 'pick' && action !== 'reword' && action !== 'squash' && action !== 'fixup' && action !== 'drop') {
      throw new RebaseRouteError(`todo ${i} has unsupported action: ${String(action)}`, 'bad-todos');
    }
    const hash = o['hash'];
    if (typeof hash !== 'string' || !/^[0-9a-f]{7,40}$/.test(hash)) {
      throw new RebaseRouteError(`todo ${i} has a malformed hash`, 'bad-todos');
    }
    const subject = typeof o['subject'] === 'string' ? o['subject'] : '';
    const message = typeof o['message'] === 'string' ? o['message'] : undefined;
    if (message !== undefined && message.includes('\n')) {
      throw new RebaseRouteError(`todo ${i} reword message must be single-line`, 'bad-todos');
    }
    return { action, hash, subject, message };
  });
}

export async function handleRebaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const isRebase = path.startsWith(REBASE_PREFIX);
  const isStash = path.startsWith(STASH_PREFIX);
  if (!isRebase && !isStash) return false;
  const actor = 'human';

  const fail = (action: string, err: unknown): true => {
    if (err instanceof RebaseRouteError) {
      ctx.audit.record(actor, action, 'rebase', path, { code: err.code, message: err.message });
      ctx.json(res, err.status, { error: err.message, code: err.code });
    } else if (err instanceof RebaseError) {
      const status =
        err.code === 'NOT_A_REPO'
          ? 404
          : err.code === 'DIRTY_TREE' || err.code === 'REBASE_IN_PROGRESS' || err.code === 'NO_REBASE'
            ? 409
            : 400;
      ctx.audit.record(actor, action, 'rebase', path, { code: err.code, message: err.message });
      ctx.json(res, status, { error: err.message, code: err.code });
    } else {
      ctx.json(res, 500, { error: (err as Error).message });
    }
    return true;
  };

  try {
    // ---- rebase todos (read-only) ------------------------------------
    if (path === `${REBASE_PREFIX}/todos` && method === 'GET') {
      const repo = resolveRepo(url.searchParams.get('repo'));
      const base = url.searchParams.get('base');
      if (!base) throw new RebaseRouteError('base is required', 'bad-base');
      const baseSha = resolveRef(repo, base);
      const commits = logRange(repo, base);
      ctx.json(res, 200, {
        repo,
        base,
        baseSha,
        head: headSha(repo),
        commits,
        todos: commits.map((c) => ({ action: 'pick', hash: c.hash, subject: c.subject })),
      });
      return true;
    }

    // ---- rebase status (read-only) ------------------------------------
    if (path === `${REBASE_PREFIX}/status` && method === 'GET') {
      const repo = resolveRepo(url.searchParams.get('repo'));
      const inProgress = rebaseInProgress(repo);
      ctx.json(res, 200, {
        repo,
        inProgress,
        head: headSha(repo),
        todoRaw: inProgress ? readInProgressTodo(repo) : null,
        conflictedFiles: inProgress ? listConflicted(repo) : [],
      });
      return true;
    }

    // ---- rebase start --------------------------------------------------
    if (path === `${REBASE_PREFIX}/start` && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const base = body['base'];
      if (typeof base !== 'string' || !base.trim()) {
        throw new RebaseRouteError('base is required', 'bad-base');
      }
      const todos = parseTodos(body['todos']);
      let checkpointId: string;
      try {
        const cp = createShadowCheckpoint(shadowCheckpointStore(), {
          workspaceId: shadowWorkspaceId(repo),
          workspacePath: repo,
          label: `rebase onto ${base.trim()}`,
        });
        checkpointId = cp.id;
      } catch (err) {
        ctx.audit.record(actor, 'REBASE_REJECTED', 'rebase', repo, {
          reason: `checkpoint failed: ${(err as Error).message}`,
        });
        throw new RebaseRouteError(
          `shadow checkpoint unavailable; rebase refused: ${(err as Error).message}`,
          'REBASE_CHECKPOINT_UNAVAILABLE',
          503,
        );
      }
      const result = startRebase({ repo, base: base.trim(), todos, checkpointId });
      ctx.audit.record(actor, 'REBASE_STARTED', 'rebase', repo, {
        base: base.trim(),
        status: result.status,
        checkpointId,
      });
      ctx.json(res, 200, result);
      return true;
    }

    // ---- rebase abort / continue / skip --------------------------------
    const lifecycle = path === `${REBASE_PREFIX}/abort` ? abortRebase
      : path === `${REBASE_PREFIX}/continue` ? continueRebase
      : path === `${REBASE_PREFIX}/skip` ? skipRebase
      : null;
    if (lifecycle && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const result = lifecycle(repo);
      ctx.audit.record(actor, `REBASE_${path.split('/').pop()?.toUpperCase()}`, 'rebase', repo, {
        status: result.status,
      });
      ctx.json(res, 200, result);
      return true;
    }

    // ---- rebase restore from shadow checkpoint --------------------------
    if (path === `${REBASE_PREFIX}/restore` && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const checkpointId = body['checkpointId'];
      if (typeof checkpointId !== 'string' || !checkpointId.trim()) {
        throw new RebaseRouteError('checkpointId is required', 'bad-checkpoint');
      }
      const restored = restoreShadowCheckpoint(shadowCheckpointStore(), {
        workspaceId: shadowWorkspaceId(repo),
        workspacePath: repo,
        checkpointId: checkpointId.trim(),
      });
      ctx.audit.record(actor, 'REBASE_RESTORED', 'rebase', repo, { checkpointId });
      ctx.json(res, 200, restored);
      return true;
    }

    // ---- stash list / show (read-only) ----------------------------------
    if (path === STASH_PREFIX && method === 'GET') {
      const repo = resolveRepo(url.searchParams.get('repo'));
      ctx.json(res, 200, { repo, entries: listStash(repo) });
      return true;
    }
    if (path === `${STASH_PREFIX}/show` && method === 'GET') {
      const repo = resolveRepo(url.searchParams.get('repo'));
      const index = url.searchParams.get('index');
      if (!index) throw new RebaseRouteError('index is required', 'bad-index');
      ctx.json(res, 200, { repo, index, diff: showStash(repo, index) });
      return true;
    }

    // ---- stash push ------------------------------------------------------
    if (path === `${STASH_PREFIX}/push` && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const message = body['message'];
      if (typeof message !== 'string' || !message.trim()) {
        throw new RebaseRouteError('message is required', 'bad-message');
      }
      const entry = pushStash(repo, message, body['includeUntracked'] === true);
      ctx.audit.record(actor, 'STASH_PUSHED', 'rebase', repo, { index: entry.index });
      ctx.json(res, 200, { entry });
      return true;
    }

    // ---- stash apply / pop / drop ----------------------------------------
    const stashVerb = path === `${STASH_PREFIX}/apply` ? 'apply'
      : path === `${STASH_PREFIX}/pop` ? 'pop'
      : path === `${STASH_PREFIX}/drop` ? 'drop'
      : null;
    if (stashVerb && method === 'POST') {
      const body = await ctx.readBody(req);
      const repo = resolveRepo(body['repo']);
      const index = body['index'];
      if (typeof index !== 'string' || !index.trim()) {
        throw new RebaseRouteError('index is required', 'bad-index');
      }
      if (stashVerb === 'drop') {
        dropStash(repo, index);
        ctx.audit.record(actor, 'STASH_DROPPED', 'rebase', repo, { index });
        ctx.json(res, 200, { dropped: index });
        return true;
      }
      const result = stashVerb === 'apply' ? applyStash(repo, index) : popStash(repo, index);
      ctx.audit.record(actor, `STASH_${stashVerb.toUpperCase()}`, 'rebase', repo, {
        index,
        outcome: result.outcome,
      });
      ctx.json(res, 200, { index, ...result });
      return true;
    }

    return false;
  } catch (err) {
    return fail('REBASE_REQUEST_REJECTED', err);
  }
}
