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
 *     refused before checkout/merge);
 *   - POST /api/git/merge-queue (Batch 16 — enqueues the PR's task's
 *     merge: refused before the entry exists).
 * Deliberately NOT guarded (pure repository operations with no task
 * binding and no task-scoped facts): POST /api/git/branch,
 * /api/git/checkout, /api/git/push, and every GET. This module is
 * only loaded through the compiled server, so — like qa.ts and
 * approvals.ts — it imports project-guard directly; the ctx-injected
 * archivedTaskBody indirection is only needed by the two modules
 * tests import straight from src (runtime.ts, review.ts).
 *
 * Git Broker (§36, Batch 16): every write route that touches a
 * repository passes the broker gate (see brokerBlocked below) before
 * its operation runs — branch/checkout/task-branch as action
 * 'branch', commit as 'commit', push as 'push', PR merge and
 * merge-queue enqueue as 'merge'. The allowlist defaults to exactly
 * those routed actions and can be tightened with the
 * FACTORY_GIT_BROKER_ACTIONS env (comma-separated action names;
 * unknown names are a 500 configuration error, mirroring the
 * FACTORY_RUNTIME_TOOLS precedent). Every broker decision is audited
 * (GIT_BROKER_ALLOWED / GIT_BROKER_DENIED). NOT brokered: the GET
 * reads (they call GitRepo directly — the broker's 'read' category
 * exists for embedders) and POST /api/git/pr (a PrStore record
 * creation, not a git operation). RBAC needs no route change: the
 * dispatch layer already classifies /api/git/* POSTs as operator and
 * GETs as viewer, merge-queue included.
 *
 * Merge Queue (§36, Batch 16): POST /api/git/merge-queue enqueues a
 * PR and drains that repo's queue synchronously (candidate verified
 * against the CURRENT target tip before anything lands; a failed
 * candidate answers 409 with the entry, exactly like the direct
 * merge's conflict answer). GET /api/git/merge-queue?repo= lists a
 * repo's entries; GET /api/git/merge-queue/:id fetches one entry.
 * Queue state is in-process, consistent with the PrStore it consumes.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  GitRepo,
  GitError,
  GitBroker,
  GIT_ACTIONS,
  MergeQueue,
  taskBranchName,
  ensureTaskBranch,
  assertPushAllowed,
  ProtectedBranchError,
  defaultBranchProtection,
  codeChangeEvidencePayload,
  mergeEvidencePayload,
  PrStore,
  type GitAction,
  type GitBrokerContext,
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

/** Per-repo merge queues (module-level, in-process like `prs`). */
const mergeQueues = new Map<string, MergeQueue>();

function mergeQueueFor(repo: string): MergeQueue {
  let queue = mergeQueues.get(repo);
  if (!queue) {
    queue = new MergeQueue(repo, { prs });
    mergeQueues.set(repo, queue);
  }
  return queue;
}

/** Env that tightens the git broker allowlist (comma-separated actions). */
export const GIT_BROKER_ACTIONS_ENV = 'FACTORY_GIT_BROKER_ACTIONS';

/** The write actions the routes in this module perform — the default
 *  broker allowlist when the env does not narrow it. */
const ROUTED_GIT_ACTIONS: readonly GitAction[] = ['branch', 'commit', 'push', 'merge'];

/**
 * Build the git broker for one request. Policy: fail-closed allowlist
 * (env-narrowable); 'merge'/'remote' keep the package default's
 * task-binding requirement, while 'push' is exempted HERE because this
 * API's push route has never carried a task binding — requiring one
 * would be an API change, not a broker default. The task-scoped
 * archive refusal stays with the routes' project-guard (uniform 409
 * body), so no contextCheck is injected. Every decision is audited
 * through the ctx audit log; unknown env action names are a config
 * error, reported without ever running an operation.
 */
function resolveGitBroker(
  ctx: RouteContext,
): { broker: GitBroker } | { configError: string[] } {
  let allowed: readonly GitAction[] = ROUTED_GIT_ACTIONS;
  const raw = process.env[GIT_BROKER_ACTIONS_ENV];
  if (raw !== undefined) {
    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = names.filter((n) => !(GIT_ACTIONS as readonly string[]).includes(n));
    if (unknown.length > 0) return { configError: unknown };
    allowed = names as GitAction[];
  }
  return {
    broker: new GitBroker(
      { allowedActions: allowed, taskRequiredActions: ['merge', 'remote'] },
      {
        audit: (d) =>
          ctx.audit.record(
            d.actor,
            d.allowed ? 'GIT_BROKER_ALLOWED' : 'GIT_BROKER_DENIED',
            'git',
            d.repo,
            {
              action: d.action,
              reason: d.reason,
              taskId: d.taskId,
              branch: d.branch,
              remote: d.remote,
            },
          ),
      },
    ),
  };
}

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

  /**
   * Git Broker gate (§36): authorize one action before its operation
   * runs. Returns true when the request is BLOCKED and already
   * answered (500 on a broker configuration error, 403 on a denial);
   * false when the action may proceed. A blocked action has zero
   * side effects — the operation is never invoked.
   */
  const brokerBlocked = async (
    action: GitAction,
    bctx: GitBrokerContext,
  ): Promise<boolean> => {
    const resolved = resolveGitBroker(ctx);
    if ('configError' in resolved) {
      ctx.audit.record(bctx.actor, 'GIT_BROKER_CONFIG_ERROR', 'git', bctx.repo, {
        env: GIT_BROKER_ACTIONS_ENV,
        unknownActions: resolved.configError,
      });
      ctx.json(res, 500, {
        error:
          `${GIT_BROKER_ACTIONS_ENV} names unknown git action(s): ` +
          `${resolved.configError.join(', ')} (known: ${GIT_ACTIONS.join(', ')})`,
      });
      return true;
    }
    const decision = await resolved.broker.authorize(action, bctx);
    if (decision.allowed) return false;
    ctx.json(res, 403, {
      error: `git broker denied action "${action}": ${decision.reason ?? 'denied'}`,
      code: 'GIT_BROKER_DENIED',
      action,
      reason: decision.reason,
    });
    return true;
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

    if (method === 'GET' && path === '/api/git/merge-queue') {
      const repo = str(url.searchParams.get('repo'));
      if (!repo) return ctx.json(res, 400, { error: 'repo query param is required' }), true;
      const queue = mergeQueues.get(repo);
      return ctx.json(res, 200, { repo, entries: queue ? queue.list() : [] }), true;
    }

    const mqEntryMatch = path.match(/^\/api\/git\/merge-queue\/([^/]+)$/);
    if (method === 'GET' && mqEntryMatch) {
      for (const queue of mergeQueues.values()) {
        const entry = queue.get(mqEntryMatch[1]);
        if (entry) return ctx.json(res, 200, entry), true;
      }
      return ctx.json(res, 404, { error: 'merge queue entry not found' }), true;
    }

    // ----------------------------------------------------------- POST -----

    if (method === 'POST' && path === '/api/git/branch') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const name = str(b['name']);
      if (!repo || !name)
        return ctx.json(res, 400, { error: 'repo and name are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      if (await brokerBlocked('branch', { actor, repo, branch: name })) return true;
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
      if (await brokerBlocked('branch', { actor, repo, branch: ref })) return true;
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
      if (await brokerBlocked('commit', { actor, repo, taskId })) return true;
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
      if (await brokerBlocked('branch', { actor, repo, taskId })) return true;
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
      if (
        await brokerBlocked('merge', {
          actor,
          repo,
          taskId: pr.taskId,
          branch: pr.sourceBranch,
        })
      )
        return true;
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

    // §36 Merge Queue — enqueue a PR and drain this repo's queue.
    // The candidate is verified against the CURRENT target tip before
    // anything lands; a failed candidate answers 409 with the entry
    // (mirroring the direct merge's conflict answer), a landed one 201.
    if (method === 'POST' && path === '/api/git/merge-queue') {
      const b = await ctx.readBody(req);
      const repo = str(b['repo']);
      const prId = str(b['prId']);
      if (!repo || !prId)
        return ctx.json(res, 400, { error: 'repo and prId are required' }), true;
      const actor = str(b['actor']) ?? 'human';
      let pr;
      try {
        pr = prs.get(prId);
      } catch (e) {
        return ctx.json(res, 404, { error: (e as Error).message }), true;
      }
      if (pr.status !== 'OPEN') {
        return ctx.json(res, 409, { error: `PR ${pr.id} is ${pr.status}, not OPEN` }), true;
      }
      // Batch 16 — the queued merge hangs merge evidence on the PR's
      // task exactly like the direct merge: refused while its project
      // is archived, before the queue entry exists.
      if (pr.taskId && isTaskProjectArchived(ctx.fdb, pr.taskId)) {
        return (
          ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, pr.taskId) as string)),
          true
        );
      }
      if (
        await brokerBlocked('merge', {
          actor,
          repo,
          taskId: pr.taskId,
          branch: pr.sourceBranch,
        })
      )
        return true;
      const queue = mergeQueueFor(repo);
      let entry;
      try {
        entry = queue.enqueue(pr, actor);
      } catch (e) {
        return ctx.json(res, 409, { error: (e as Error).message }), true;
      }
      ctx.audit.record(actor, 'GIT_MERGE_QUEUE_ENQUEUED', 'git', repo, {
        entryId: entry.id,
        prId: pr.id,
        taskId: pr.taskId,
      });
      const processed = await queue.processAll({
        audit: auditHook(actor),
        onMerged: (_mergedEntry, mergedPr) => {
          // The same merge evidence the direct merge route hangs on
          // the task (the PR record is already marked MERGED here).
          if (mergedPr.taskId) {
            const payload = mergeEvidencePayload(mergedPr);
            ctx.evidence.create({
              taskId: mergedPr.taskId,
              type: payload.type,
              title: `PR merged: ${mergedPr.title}`,
              payload: payload.payload,
              createdBy: actor,
            });
          }
        },
      });
      const mine = processed.find((e) => e.id === entry.id) ?? queue.get(entry.id);
      if (mine && mine.status === 'FAILED') {
        return (
          ctx.json(res, 409, {
            error: mine.failureReason ?? 'merge candidate verification failed',
            entry: mine,
            conflicts: mine.verification?.conflicts ?? [],
          }),
          true
        );
      }
      return ctx.json(res, 201, { ok: true, entry: mine }), true;
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
      if (await brokerBlocked('push', { actor, repo, branch: target, remote: 'origin' }))
        return true;
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
