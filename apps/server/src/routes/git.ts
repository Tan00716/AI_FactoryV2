/**
 * Git routes — spec §34.
 * Exported as `handleGitRoutes`; the coordinator wires it into
 * apps/server/src/index.ts (this file is intentionally not imported there yet).
 *
 * Archived-project write guard (Batch 15, shared decision in
 * routes/project-guard.ts): the POSTs that create task-scoped facts
 * refuse with 409 PROJECT_ARCHIVED while the task's project is
 * archived, before any side effect —
 *   - POST /api/git/commit (when taskId is given: it hangs
 *     code-change evidence on the task — refused BEFORE the commit
 *     itself, so the repo is untouched too);
 *   - POST /api/git/task-branch (creates the task's branch);
 *   - POST /api/git/pr (creates a PR record bound to the task);
 *   - POST /api/git/pr/:id/merge (hangs merge evidence on the task —
 *     refused before checkout/merge).
 * Deliberately NOT guarded (pure repository operations with no task
 * binding and no task-scoped facts): POST /api/git/branch,
 * /api/git/checkout, /api/git/push, and every GET. This module is
 * only loaded through the compiled server, so — like qa.ts and
 * approvals.ts — it imports project-guard directly; the ctx-injected
 * archivedTaskBody indirection is only needed by the two modules
 * tests import straight from src (runtime.ts, review.ts).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  GitRepo,
  GitError,
  taskBranchName,
  ensureTaskBranch,
  assertPushAllowed,
  ProtectedBranchError,
  defaultBranchProtection,
  codeChangeEvidencePayload,
  mergeEvidencePayload,
  PrStore,
} from '@ai-factory/git';
import type { RouteContext } from './context';
import {
  isTaskProjectArchived,
  projectArchivedBody,
  projectIdOfTask,
} from './project-guard';

/** In-memory PR records for the prototype (module-level, per spec task 9). */
const prs = new PrStore();

const protection = defaultBranchProtection();

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function gitErrorStatus(e: unknown): number {
  if (e instanceof ProtectedBranchError) return 403;
  if (e instanceof GitError) return 500;
  return 500;
}

/**
 * Route git API calls. Returns true when the request was handled.
 */
export async function handleGitRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/git/')) return false;

  const auditHook =
    (actor: string) =>
    (action: string, details: Record<string, unknown>): void => {
      ctx.audit.record(actor, action, 'git', String(details.repo ?? ''), details);
    };

  try {
    // ------------------------------------------------------------ GET -----

    if (method === 'GET' && path === '/api/git/status') {
      const repo = str(url.searchParams.get('repo'));
      if (!repo) return ctx.json(res, 400, { error: 'repo query param is required' }), true;
      return ctx.json(res, 200, await new GitRepo(repo).status()), true;
    }

    if (method === 'GET' && path === '/api/git/branches') {
      const repo = str(url.searchParams.get('repo'));
      if (!repo) return ctx.json(res, 400, { error: 'repo query param is required' }), true;
      return ctx.json(res, 200, await new GitRepo(repo).branches()), true;
    }

    if (method === 'GET' && path === '/api/git/log') {
      const repo = str(url.searchParams.get('repo'));
      if (!repo) return ctx.json(res, 400, { error: 'repo query param is required' }), true;
      const limit = Number(url.searchParams.get('limit') ?? '20') || 20;
      return ctx.json(res, 200, await new GitRepo(repo).log(limit)), true;
    }

    if (method === 'GET' && path === '/api/git/diff') {
      const repo = str(url.searchParams.get('repo'));
      if (!repo) return ctx.json(res, 400, { error: 'repo query param is required' }), true;
      const ref = str(url.searchParams.get('ref'));
      const diff = await new GitRepo(repo).diff(ref);
      return ctx.json(res, 200, { diff }), true;
    }

    // ----------------------------------------------------------- POST -----

    if (method === 'POST' && path === '/api/git/branch') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const name = str(b['name']);
      if (!repo || !name)
        return ctx.json(res, 400, { error: 'repo and name are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      await new GitRepo(repo).createBranch(name, { audit: auditHook(actor) });
      ctx.audit.record(actor, 'GIT_BRANCH_CREATED', 'git', repo, { branch: name });
      return ctx.json(res, 201, { ok: true, branch: name }), true;
    }

    if (method === 'POST' && path === '/api/git/checkout') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const ref = str(b['ref']);
      if (!repo || !ref)
        return ctx.json(res, 400, { error: 'repo and ref are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      await new GitRepo(repo).checkout(ref, { audit: auditHook(actor) });
      ctx.audit.record(actor, 'GIT_CHECKOUT', 'git', repo, { ref });
      return ctx.json(res, 200, { ok: true, ref }), true;
    }

    if (method === 'POST' && path === '/api/git/commit') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const message = str(b['message']);
      if (!repo || !message)
        return ctx.json(res, 400, { error: 'repo and message are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      const taskId = str(b['taskId']);
      // Batch 15 — with a taskId this commit hangs evidence on the
      // task: refused while its project is archived, BEFORE the
      // commit happens (zero side effects, repo included). Without a
      // taskId it is a pure repository operation and stays unguarded.
      if (taskId && isTaskProjectArchived(ctx.fdb, taskId)) {
        return (
          ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string)),
          true
        );
      }
      const g = new GitRepo(repo);
      const sha = await g.commit(message, { audit: auditHook(actor) });
      ctx.audit.record(actor, 'GIT_COMMIT', 'git', repo, { sha, message, taskId: taskId ?? null });
      let evidence: unknown = null;
      if (taskId) {
        const [entry] = await g.log(1);
        const payload = codeChangeEvidencePayload(entry);
        evidence = ctx.evidence.create({
          taskId,
          type: payload.type,
          title: `commit ${sha.slice(0, 8)}: ${message.slice(0, 60)}`,
          payload: payload.payload,
          createdBy: actor,
        });
      }
      return ctx.json(res, 201, { ok: true, sha, evidence }), true;
    }

    if (method === 'POST' && path === '/api/git/task-branch') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const taskId = str(b['taskId']);
      const title = str(b['title']);
      if (!repo || !taskId || !title)
        return ctx.json(res, 400, { error: 'repo, taskId and title are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      // Batch 15 — a task branch is a task-scoped fact: refused while
      // the task's project is archived, before the branch is created.
      if (isTaskProjectArchived(ctx.fdb, taskId)) {
        return (
          ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string)),
          true
        );
      }
      const g = new GitRepo(repo);
      const base = str(b['base']);
      const branch = await ensureTaskBranch(g, taskId, title, base ?? 'main', {
        audit: auditHook(actor),
      });
      ctx.audit.record(actor, 'GIT_TASK_BRANCH', 'git', repo, { taskId, branch });
      return ctx.json(res, 201, { ok: true, branch, taskId }), true;
    }

    if (method === 'POST' && path === '/api/git/pr') {
      const b = await ctx.readBody(req);
      const taskId = str(b['taskId']);
      const sourceBranch = str(b['sourceBranch']);
      const targetBranch = str(b['targetBranch']);
      const title = str(b['title']);
      if (!taskId || !sourceBranch || !targetBranch || !title) {
        return (
          ctx.json(res, 400, { error: 'taskId, sourceBranch, targetBranch and title are required' }),
          true
        );
      }
      const actor = str(b['actor']) ?? 'human';
      const repo = str(b['repo']) ?? '';
      // Batch 15 — the PR record is bound to the task: refused while
      // its project is archived, before the record exists.
      if (isTaskProjectArchived(ctx.fdb, taskId)) {
        return (
          ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string)),
          true
        );
      }
      const pr = prs.create({
        taskId,
        sourceBranch,
        targetBranch,
        title,
        createdBy: actor,
        commits: Array.isArray(b['commits'])
          ? (b['commits'] as unknown[]).filter((c): c is string => typeof c === 'string')
          : [],
      });
      ctx.audit.record(actor, 'GIT_PR_CREATED', 'pr', pr.id, {
        repo,
        taskId,
        sourceBranch,
        targetBranch,
        title,
      });
      return ctx.json(res, 201, pr), true;
    }

    const prMergeMatch = path.match(/^\/api\/git\/pr\/([^/]+)\/merge$/);
    if (method === 'POST' && prMergeMatch) {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      if (!repo) return ctx.json(res, 400, { error: 'repo is required' }), true;
      const actor = str(b['actor']) ?? 'human';
      let pr;
      try {
        pr = prs.get(prMergeMatch[1]);
      } catch (e) {
        return ctx.json(res, 404, { error: (e as Error).message }), true;
      }
      // Batch 15 — a merge hangs merge evidence on the PR's task:
      // refused while its project is archived, before checkout/merge
      // touch the repo (the PR stays unmerged).
      if (pr.taskId && isTaskProjectArchived(ctx.fdb, pr.taskId)) {
        return (
          ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, pr.taskId) as string)),
          true
        );
      }
      const g = new GitRepo(repo);
      await g.checkout(pr.targetBranch, { audit: auditHook(actor) });
      const result = await g.merge(pr.sourceBranch, { audit: auditHook(actor) });
      if (!result.ok) {
        return (
          ctx.json(res, 409, {
            error: `merge conflicts in ${result.conflicts.join(', ')} — resolve them manually`,
            conflicts: result.conflicts,
          }),
          true
        );
      }
      const merged = prs.updateStatus(pr.id, 'MERGED');
      ctx.audit.record(actor, 'GIT_PR_MERGED', 'pr', pr.id, {
        repo,
        taskId: pr.taskId,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      let evidence: unknown = null;
      if (pr.taskId) {
        const payload = mergeEvidencePayload(merged);
        evidence = ctx.evidence.create({
          taskId: pr.taskId,
          type: payload.type,
          title: `PR merged: ${pr.title}`,
          payload: payload.payload,
          createdBy: actor,
        });
      }
      return ctx.json(res, 200, { ok: true, pr: merged, evidence }), true;
    }

    if (method === 'POST' && path === '/api/git/push') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const branch = str(b['branch']);
      if (!repo) return ctx.json(res, 400, { error: 'repo is required' }), true;
      const actor = str(b['actor']) ?? 'human';
      // Protection applies to the branch being pushed (fall back to current).
      const g = new GitRepo(repo);
      const target = branch ?? (await g.status()).branch;
      try {
        assertPushAllowed(target, protection);
      } catch (e) {
        if (e instanceof ProtectedBranchError) {
          ctx.audit.record(actor, 'GIT_PUSH_DENIED', 'git', repo, {
            branch: target,
            reason: e.message,
          });
          return ctx.json(res, 403, { error: e.message }), true;
        }
        throw e;
      }
      await g.push('origin', branch, { audit: auditHook(actor) });
      ctx.audit.record(actor, 'GIT_PUSH', 'git', repo, { branch: target });
      return ctx.json(res, 200, { ok: true, branch: target }), true;
    }

    return false;
  } catch (e) {
    return (
      ctx.json(res, gitErrorStatus(e), {
        error: e instanceof Error ? e.message : 'git operation failed',
      }),
      true
    );
  }
}

/** Expected branch-name for a task (exported for reuse by other route modules). */
export function gitTaskBranchName(taskId: string, title: string): string {
  return taskBranchName(taskId, title);
}
