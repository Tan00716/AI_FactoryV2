/**
 * Recipe routes — deterministic recipe-based code migration
 * (Amazon Q `/transform` / OpenRewrite style, zero-model).
 *
 *   GET    /api/recipes                     builtin + custom library (summary)
 *   GET    /api/recipes/:name               full recipe document
 *   POST   /api/recipes/validate            {recipeJson} → dry-run validation
 *   POST   /api/recipes                     {recipeJson} → add custom recipe → 201
 *   DELETE /api/recipes/:name               remove a CUSTOM recipe (builtins refuse)
 *   POST   /api/recipes/plan                {recipeName, projectPath} → plan (no writes) → 201
 *   GET    /api/recipes/runs                list recipe runs (summary)
 *   GET    /api/recipes/runs/:id            full run (plan diffs + approval status + results)
 *   POST   /api/recipes/runs/:id/request-approval → central approval, action recipes.apply:<id>
 *   POST   /api/recipes/runs/:id/execute    {approvalId} → approval-gated apply + verify
 *   DELETE /api/recipes/runs/:id            drop the run record (never reverts target files)
 *
 * RBAC: central gate maps GET → viewer, mutations → operator for this
 * prefix — no auth.ts change. Every mutation is audited (RECIPE_PLAN_CREATED /
 * RECIPE_APPROVAL_REQUESTED / RECIPE_APPLIED / RECIPE_VERIFY_* / …).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApprovalManager } from '@ai-factory/approvals';
import type { RouteContext } from './context';
import {
  RecipeError,
  RecipeExecutor,
  RecipeRunStore,
  CustomRecipeStore,
  applyActionFor,
  parseRecipeJson,
  planDigest,
  recipeErrorStatus,
  type ApprovalChecker,
  type RecipeSpec,
  type RecipeRun,
} from '../recipes';
import { detectOutOfScopePaths, hasScope } from '../scope-lock';

const PREFIX = '/api/recipes';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'] ?? body['actor'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

function errBody(e: unknown): Record<string, unknown> {
  if (e instanceof RecipeError) return { error: e.code, message: e.message };
  return { error: 'RECIPE_FAILED', message: (e as Error).message ?? 'unknown' };
}

function recipeSummary(r: RecipeSpec): Record<string, unknown> {
  return {
    name: r.name,
    version: r.version,
    description: r.description,
    tags: r.tags,
    source: r.source,
    opCount: r.transform.length,
    verify: r.verify ?? null,
    notes: r.notes ?? null,
  };
}

function runSummary(r: RecipeRun): Record<string, unknown> {
  return {
    id: r.id,
    recipeName: r.recipeName,
    recipeVersion: r.recipeVersion,
    projectPath: r.projectPath,
    status: r.status,
    approvalId: r.approvalId ?? null,
    appliedOps: r.plan.appliedOps,
    errorOps: r.plan.errorOps,
    unhandled: r.plan.unhandled.length,
    verify: r.verifyResults.map((v) => ({ kind: v.kind, ok: v.ok, exitCode: v.exitCode })),
    failReason: r.failReason ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function handleRecipesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const rest = path.slice(PREFIX.length);

  const approvalChecker: ApprovalChecker = {
    getApproval(id: string) {
      const manager = new ApprovalManager(ctx.fdb.approvals, {
        audit: (action, entityId, details) => ctx.audit.record('recipe-service', action, 'approval', entityId, details),
      });
      try {
        const a = manager.get(id);
        return { status: a.status, action: a.action, requester: a.requester };
      } catch {
        return null;
      }
    },
  };

  const executor = new RecipeExecutor({
    runStore: new RecipeRunStore(),
    customStore: new CustomRecipeStore(),
    audit: ctx.audit,
    approvals: approvalChecker,
  });
  const runStore = new RecipeRunStore();
  if (runStore.isCorrupt()) {
    return ctx.json(res, 503, { error: 'STORE_CORRUPT', message: 'recipe run store is corrupt; refuses reads/writes' }), true;
  }

  // GET /api/recipes/runs → list runs.
  if (rest === '/runs' && method === 'GET') {
    return ctx.json(res, 200, { runs: runStore.list().map(runSummary) }), true;
  }

  // GET /api/recipes → library.
  if (rest === '' && method === 'GET') {
    try {
      return ctx.json(res, 200, { recipes: executor.listRecipes().map(recipeSummary) }), true;
    } catch (e) {
      return ctx.json(res, recipeErrorStatus(e), errBody(e)), true;
    }
  }

  // POST /api/recipes/validate — dry-run custom recipe validation.
  if (rest === '/validate' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const parsed = parseRecipeJson(str(body['recipeJson']) ?? '', 'custom');
      return ctx.json(res, 200, { ok: true, recipe: recipeSummary(parsed) }), true;
    } catch (e) {
      return ctx.json(res, recipeErrorStatus(e), { ok: false, ...errBody(e) }), true;
    }
  }

  // POST /api/recipes → add custom recipe.
  if (rest === '' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const recipe = executor.addCustomRecipe(str(body['recipeJson']) ?? '', actorOf(body));
      return ctx.json(res, 201, { recipe: recipeSummary(recipe) }), true;
    } catch (e) {
      return ctx.json(res, recipeErrorStatus(e), errBody(e)), true;
    }
  }

  // POST /api/recipes/plan → compute plan (no writes).
  if (rest === '/plan' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const taskId = str(body['taskId']) ?? str(body['task_id']);
      if (taskId) {
        try {
          ctx.tasks.get(taskId);
        } catch {
          return ctx.json(res, 404, { error: 'TASK_NOT_FOUND', message: `task not found: ${taskId}` }), true;
        }
      }
      const run = executor.createPlan(str(body['recipeName']) ?? '', str(body['projectPath']) ?? '', actorOf(body), taskId);
      // Scope Lock （二轮加强 8) — a plan computed ON a scoped task
      // whose target files escape the task's edit scope is refused
      // outright (422 SCOPE_LOCKED), never silently trimmed to the
      // in-scope subset: a migration that quietly skips half its files
      // is a lie about what will run. The plan is pure (no writes),
      // so discarding the run record leaves nothing behind.
      if (taskId) {
        const taskScope = ctx.tasks.get(taskId).scope;
        if (taskScope && hasScope(taskScope)) {
          const plannedPaths = run.plan.files.map((f) => f.file);
          const violations = detectOutOfScopePaths(taskScope, plannedPaths);
          if (violations.length > 0) {
            runStore.remove(run.id);
            ctx.audit.record(actorOf(body), 'SCOPE_VIOLATION', 'recipe-run', run.id, {
              taskId,
              surface: 'recipes.plan',
              files: violations.map((v) => v.path),
              reasons: violations.map((v) => `${v.path}:${v.reason}`),
              code: 'SCOPE_LOCKED',
              note: 'recipe plan refused: target files outside the task edit scope; plan discarded, nothing written',
            });
            return ctx.json(res, 422, {
              error: 'recipe plan targets files outside the task edit scope',
              code: 'SCOPE_LOCKED',
              taskId,
              violations,
            }), true;
          }
        }
      }
      return ctx.json(res, 201, { run }), true;
    } catch (e) {
      return ctx.json(res, recipeErrorStatus(e), errBody(e)), true;
    }
  }

  // GET /api/recipes/:name → full recipe (single-segment name, not 'runs').
  {
    const m = rest.match(/^\/([^/]+)$/);
    if (m && method === 'GET') {
      const recipe = executor.getRecipe(decodeURIComponent(m[1]));
      if (!recipe) return ctx.json(res, 404, { error: 'RECIPE_NOT_FOUND' }), true;
      return ctx.json(res, 200, { recipe }), true;
    }
  }

  // DELETE /api/recipes/:name → remove CUSTOM recipe.
  {
    const m = rest.match(/^\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const name = decodeURIComponent(m[1]);
      const builtin = executor.getRecipe(name)?.source === 'builtin';
      if (builtin) {
        return ctx.json(res, 400, { error: 'RECIPE_INVALID', message: 'builtin recipes cannot be deleted' }), true;
      }
      const removed = executor.removeCustomRecipe(name, actorOf(body));
      return ctx.json(res, 200, { removed }), true;
    }
  }

  // GET /api/recipes/runs/:id → full run + approval status.
  {
    const m = rest.match(/^\/runs\/([^/]+)$/);
    if (m && method === 'GET') {
      const run = runStore.get(m[1]);
      if (!run) return ctx.json(res, 404, { error: 'RUN_NOT_FOUND' }), true;
      let approvalStatus: string | null = null;
      if (run.approvalId) {
        approvalStatus = approvalChecker.getApproval(run.approvalId)?.status ?? null;
      }
      return ctx.json(res, 200, { run, approvalStatus }), true;
    }
  }

  // POST /api/recipes/runs/:id/request-approval → central approval (action recipes.apply:<id>).
  {
    const m = rest.match(/^\/runs\/([^/]+)\/request-approval$/);
    if (m && method === 'POST') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const actor = actorOf(body);
      const run = runStore.get(m[1]);
      if (!run) return ctx.json(res, 404, { error: 'RUN_NOT_FOUND' }), true;
      if (!run.taskId) {
        // §23.3 approvals are task-bound by schema (task_id NOT NULL
        // REFERENCES tasks(id)); a recipe run approves migration work
        // ON a task, so a taskId is required at plan time.
        return ctx.json(res, 400, {
          error: 'TASK_REQUIRED',
          message: 'this run has no taskId — plans approve migration work on a task (supply taskId when planning)',
        }), true;
      }
      try {
        const manager = new ApprovalManager(ctx.fdb.approvals, {
          audit: (action, entityId, details) => ctx.audit.record('recipe-service', action, 'approval', entityId, details),
        });
        const approval = manager.request({
          action: applyActionFor(run.id),
          requester: actor,
          task_id: run.taskId,
          risk_level: 'HIGH',
          candidate_digest: planDigest(run.plan),
          reversibility_ref: `recipe-run:${run.id}`,
          required_approvers: ['human'],
        });
        const updated = executor.attachApproval(run.id, approval.approval_id, actor);
        ctx.notify.emit({
          type: 'APPROVAL_PENDING',
          actor,
          entity: { kind: 'approval', id: approval.approval_id, label: applyActionFor(run.id) },
          detail: { risk_level: 'HIGH', recipe: run.recipeName },
        });
        return ctx.json(res, 201, { approvalId: approval.approval_id, run: runSummary(updated) }), true;
      } catch (e) {
        return ctx.json(res, 400, { error: (e as Error).message ?? 'approval request failed' }), true;
      }
    }
  }

  // POST /api/recipes/runs/:id/execute → approval-gated apply + verify.
  {
    const m = rest.match(/^\/runs\/([^/]+)\/execute$/);
    if (m && method === 'POST') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const approvalId = str(body['approvalId']);
      try {
        const run = await executor.executeRun(m[1], approvalId, actorOf(body));
        return ctx.json(res, 200, { run }), true;
      } catch (e) {
        return ctx.json(res, recipeErrorStatus(e), errBody(e)), true;
      }
    }
  }

  // DELETE /api/recipes/runs/:id → drop record (never reverts target files).
  {
    const m = rest.match(/^\/runs\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const removed = runStore.remove(m[1]);
      if (removed) {
        ctx.audit.record(actorOf(body), 'RECIPE_RUN_DELETED', 'recipe-run', m[1], {});
      }
      return ctx.json(res, 200, { removed }), true;
    }
  }

  return ctx.json(res, 404, { error: 'NOT_FOUND' }), true;
}
