/**
 * Repo map routes — deterministic structural repository summary.
 *
 *   GET /api/repomap?root=&format=json|md&maxTokens=
 *
 * Builds (incrementally — unchanged files are reused via the
 * codeindex mtime+size watermarks) the importance-ranked repo map
 * for a jailed root and returns it as JSON (default) or rendered
 * markdown. The map is heuristic (regex-based defs, name-based
 * refs) — see @ai-factory/repomap's documented limitations.
 *
 * Path jail: `root` is realpath-resolved and must sit inside
 * FACTORY_CODEINDEX_ROOTS (comma-separated). Empty allowlist = deny
 * everything (fail-closed). Map JSON is cached under
 * FACTORY_DATA_DIR/repomap (or ~/.ai-factory/repomap).
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET →
 * viewer (read-only, idempotent — rebuilding only refreshes a
 * cache). No auth.ts change.
 *
 * The coordinator wires this in: handleRepoMapRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RepoMapError, RepoMapService } from '@ai-factory/repomap';
import type { RouteContext } from './context';

const PREFIX = '/api/repomap';

/** One service per process (owns the map cache). */
let service: RepoMapService | null = null;

export function getRepoMapService(): RepoMapService {
  if (!service) service = new RepoMapService();
  return service;
}

/** For tests: replace the singleton. */
export function setRepoMapService(svc: RepoMapService | null): void {
  service = svc;
}

function repoMapError(res: ServerResponse, ctx: RouteContext, err: unknown): boolean {
  if (err instanceof RepoMapError) {
    const status = err.code === 'ROOT_DENIED' ? 403 : 400;
    ctx.json(res, status, { error: err.code, detail: err.message });
    return true;
  }
  ctx.json(res, 500, { error: 'repomap failed', detail: err instanceof Error ? err.message : String(err) });
  return true;
}

export async function handleRepoMapRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const svc = getRepoMapService();

  // GET /api/repomap?root=&format=json|md&maxTokens=
  if (method === 'GET' && path === PREFIX) {
    const root = url.searchParams.get('root') ?? '';
    const format = url.searchParams.get('format') === 'md' ? 'md' : 'json';
    const maxTokens = Math.min(
      100000,
      Math.max(100, Math.floor(Number(url.searchParams.get('maxTokens')) || 20000)),
    );
    if (!root.trim()) {
      ctx.json(res, 400, { error: 'root is required' });
      return true;
    }
    try {
      const t0 = Date.now();
      const { map, markdown, stats } = await svc.buildMap(root.trim(), { maxTokens });
      ctx.audit.record('server', 'REPOMAP_BUILT', 'repomap', stats.root, {
        files: stats.files,
        symbols: stats.symbols,
        truncated: stats.truncated,
        ms: Date.now() - t0,
      });
      if (format === 'md') {
        ctx.json(res, 200, { format: 'md', root: stats.root, markdown, stats });
      } else {
        ctx.json(res, 200, { format: 'json', root: stats.root, map, markdown, stats });
      }
    } catch (err) {
      return repoMapError(res, ctx, err);
    }
    return true;
  }

  return false;
}
