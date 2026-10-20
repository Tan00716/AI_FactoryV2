/**
 * Batch Changes routes — declarative multi-repo batch changes
 * (Sourcegraph Batch Changes style, zero-model).
 *
 *   GET    /api/batch-changes                 list batches (summary)
 *   POST   /api/batch-changes                 {specYaml, createdBy?} → 201
 *   GET    /api/batch-changes/:id             full batch with per-repo runs
 *   POST   /api/batch-changes/:id/run         execute pending repos → 200
 *   POST   /api/batch-changes/:id/retry/:repo retry one repo → 200
 *   DELETE /api/batch-changes/:id             drop the record (never touches target repos)
 *   GET    /api/batch-changes/repos           registry list (?projectPath=)
 *   POST   /api/batch-changes/repos           {name, path, remoteUrl?, projectPath?} → 201
 *   DELETE /api/batch-changes/repos/:name     (?projectPath=)
 *
 * RBAC: the central gate (auth.ts) maps GET → viewer, mutations →
 * operator for this prefix — no auth.ts change. Every mutation is
 * audited (BATCH_CREATED / BATCH_RUN_STARTED / … / REPO_REGISTERED).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  BatchError,
  BatchExecutor,
  BatchStore,
  batchErrorStatus,
  batchStorePath,
  createRepoRegistry,
  parseBatchSpecYaml,
  type BatchRecord,
} from '../batch-changes';

const PREFIX = '/api/batch-changes';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

function errBody(e: unknown): Record<string, unknown> {
  if (e instanceof BatchError) return { error: e.code, message: e.message };
  return { error: 'BATCH_FAILED', message: (e as Error).message ?? 'unknown' };
}

function summary(b: BatchRecord): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const r of b.repos) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    repoCount: b.repos.length,
    counts,
    branch: b.spec.branch,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export async function handleBatchChangesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const rest = path.slice(PREFIX.length);

  const registry = createRepoRegistry();
  let executor: BatchExecutor;
  try {
    executor = new BatchExecutor({
      registry,
      store: new BatchStore(batchStorePath()),
      audit: ctx.audit,
    });
  } catch (e) {
    return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
  }
  const store = new BatchStore(batchStorePath());
  if (store.isCorrupt()) {
    return ctx.json(res, 503, { error: 'STORE_CORRUPT', message: 'batch store is corrupt; refuses reads/writes' }), true;
  }

  // Registry: GET /api/batch-changes/repos
  if (rest === '/repos' && method === 'GET') {
    try {
      const projectPath = url.searchParams.get('projectPath') ?? undefined;
      return ctx.json(res, 200, { repos: registry.list(projectPath) }), true;
    } catch (e) {
      return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
    }
  }

  // Registry: POST /api/batch-changes/repos
  if (rest === '/repos' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const reg = registry.register({
        name: str(body['name']) ?? '',
        path: str(body['path']) ?? '',
        remoteUrl: str(body['remoteUrl']),
        projectPath: str(body['projectPath']),
        addedBy: actorOf(body),
      });
      ctx.audit.record(actorOf(body), 'REPO_REGISTERED', 'batch-repo', reg.name, {
        path: reg.path,
        scope: reg.scope,
        remoteUrl: reg.remoteUrl ? '(set)' : '(none)',
      });
      return ctx.json(res, 201, { repo: reg }), true;
    } catch (e) {
      return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
    }
  }

  // Registry: DELETE /api/batch-changes/repos/:name
  {
    const m = rest.match(/^\/repos\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      try {
        const projectPath = url.searchParams.get('projectPath') ?? undefined;
        const name = decodeURIComponent(m[1]);
        const removed = registry.unregister(name, projectPath);
        if (removed) {
          ctx.audit.record(actorOf(body), 'REPO_UNREGISTERED', 'batch-repo', name, { scope: projectPath ? 'project' : 'global' });
        }
        return ctx.json(res, 200, { removed }), true;
      } catch (e) {
        return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
      }
    }
  }

  // Spec dry-run validation: POST /api/batch-changes/validate
  if (rest === '/validate' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const spec = parseBatchSpecYaml(str(body['specYaml']) ?? '');
      const projectPath = str(body['projectPath']);
      const missing = spec.repos.filter((r) => !registry.get(r, projectPath));
      return ctx.json(res, 200, {
        ok: missing.length === 0,
        spec: {
          name: spec.name,
          repos: spec.repos,
          branch: spec.branch,
          onFailure: spec.onFailure,
          branchExists: spec.branchExists,
          push: spec.push,
          pr: spec.pr,
          steps: spec.steps.map((s) => ({ name: s.name, kind: 'run' in s ? 'run' : 'edit' })),
        },
        missingRepos: missing,
      }), true;
    } catch (e) {
      return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
    }
  }

  // POST /api/batch-changes → create batch.
  if (rest === '' && method === 'POST') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const batch = executor.createBatch(str(body['specYaml']) ?? '', actorOf(body), str(body['projectPath']));
      return ctx.json(res, 201, { batch: summary(batch) }), true;
    } catch (e) {
      return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
    }
  }

  // GET /api/batch-changes → list.
  if (rest === '' && method === 'GET') {
    return ctx.json(res, 200, { batches: store.list().map(summary) }), true;
  }

  // POST /api/batch-changes/:id/run
  {
    const m = rest.match(/^\/([^/]+)\/run$/);
    if (m && method === 'POST') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      try {
        const batch = await executor.runBatch(m[1], actorOf(body));
        return ctx.json(res, 200, { batch: summary(batch) }), true;
      } catch (e) {
        return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
      }
    }
  }

  // POST /api/batch-changes/:id/retry/:repo
  {
    const m = rest.match(/^\/([^/]+)\/retry\/([^/]+)$/);
    if (m && method === 'POST') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      try {
        const batch = await executor.retryRepo(m[1], decodeURIComponent(m[2]), actorOf(body));
        return ctx.json(res, 200, { batch: summary(batch) }), true;
      } catch (e) {
        return ctx.json(res, batchErrorStatus(e), errBody(e)), true;
      }
    }
  }

  // GET /api/batch-changes/:id → detail.
  {
    const m = rest.match(/^\/([^/]+)$/);
    if (m && method === 'GET') {
      const batch = store.get(m[1]);
      if (!batch) return ctx.json(res, 404, { error: 'BATCH_NOT_FOUND' }), true;
      return ctx.json(res, 200, { batch }), true;
    }
  }

  // DELETE /api/batch-changes/:id
  {
    const m = rest.match(/^\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const removed = store.remove(m[1]);
      if (removed) {
        ctx.audit.record(actorOf(body), 'BATCH_DELETED', 'batch', m[1], {});
      }
      return ctx.json(res, 200, { removed }), true;
    }
  }

  return ctx.json(res, 404, { error: 'NOT_FOUND' }), true;
}
