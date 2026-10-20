/**
 * Code index routes — local repository indexing for agents.
 *
 *   POST /api/codeindex/index   { root } → { stats }   (build/refresh)
 *   GET  /api/codeindex/search?root=&q=&mode=symbols|text&limit=&context=
 *   GET  /api/codeindex/definition?root=&name=
 *
 * Path jail: `root` is realpath-resolved and must sit inside
 * FACTORY_CODEINDEX_ROOTS (comma-separated). Empty allowlist = deny
 * everything (fail-closed). Index JSON is cached under
 * FACTORY_DATA_DIR/codeindex (or ~/.ai-factory/codeindex).
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps POST →
 * operator (indexing walks the filesystem — a write-side operation)
 * and GET → viewer (search is read-only). No auth.ts change.
 *
 * Indexed content is untrusted external content: snippets returned
 * here are raw for display; anything embedding them in a model prompt
 * must pass through sanitizeUntrusted() (the code_search runtime tool
 * does this).
 *
 * The coordinator wires this in: handleCodeIndexRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CodeIndexError,
  CodeIndexService,
} from '@ai-factory/codeindex';
import type { RouteContext } from './context';
import { isIgnoredSync } from '../ignore-gate';

const PREFIX = '/api/codeindex';

/** One service per process (in-memory index registry). */
let service: CodeIndexService | null = null;

export function getCodeIndexService(): CodeIndexService {
  // Task ②: the two-tier ignore gate is installed on the shared service
  // (forIndex=true — both the hard and the indexing tier keep a file out
  // of the index). The runtime code_search tool shares this singleton via
  // setRuntimeCodeIndexService, so it is gated too.
  if (!service) {
    service = new CodeIndexService({
      ignoreCheck: (root, abs, isDir) => isIgnoredSync(root, abs, true, isDir),
    });
  }
  return service;
}

/** For tests: replace the singleton. */
export function setCodeIndexService(svc: CodeIndexService | null): void {
  service = svc;
}

function codeIndexError(res: ServerResponse, ctx: RouteContext, err: unknown): boolean {
  if (err instanceof CodeIndexError) {
    const status = err.code === 'ROOT_DENIED' ? 403 : err.code === 'NOT_INDEXED' ? 409 : 400;
    ctx.json(res, status, { error: err.code, detail: err.message });
    return true;
  }
  ctx.json(res, 500, { error: 'codeindex failed', detail: err instanceof Error ? err.message : String(err) });
  return true;
}

export async function handleCodeIndexRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const svc = getCodeIndexService();

  // POST /api/codeindex/index — build or refresh the index for a root.
  if (method === 'POST' && path === `${PREFIX}/index`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const root = body['root'];
    if (typeof root !== 'string' || !root.trim()) {
      ctx.json(res, 400, { error: 'root is required' });
      return true;
    }
    try {
      const t0 = Date.now();
      const stats = await svc.buildIndex(root.trim());
      ctx.audit.record('server', 'CODEINDEX_BUILT', 'codeindex', stats.root, {
        files: stats.files,
        symbols: stats.symbols,
        ms: Date.now() - t0,
      });
      ctx.json(res, 200, { stats });
    } catch (err) {
      return codeIndexError(res, ctx, err);
    }
    return true;
  }

  // GET /api/codeindex/search?root=&q=&mode=&limit=&context=
  if (method === 'GET' && path === `${PREFIX}/search`) {
    const root = url.searchParams.get('root') ?? '';
    const q = url.searchParams.get('q') ?? '';
    const mode = url.searchParams.get('mode') === 'text' ? 'text' : 'symbols';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const contextLines = Math.min(10, Math.max(0, Number(url.searchParams.get('context')) || 0));
    if (!root.trim() || !q.trim()) {
      ctx.json(res, 400, { error: 'root and q are required' });
      return true;
    }
    try {
      const hits = await svc.search(root.trim(), q.trim(), mode, { limit, contextLines });
      ctx.json(res, 200, { mode, hits });
    } catch (err) {
      return codeIndexError(res, ctx, err);
    }
    return true;
  }

  // GET /api/codeindex/definition?root=&name=
  if (method === 'GET' && path === `${PREFIX}/definition`) {
    const root = url.searchParams.get('root') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!root.trim() || !name.trim()) {
      ctx.json(res, 400, { error: 'root and name are required' });
      return true;
    }
    try {
      const hits = await svc.getDefinition(root.trim(), name.trim());
      ctx.json(res, 200, { hits });
    } catch (err) {
      return codeIndexError(res, ctx, err);
    }
    return true;
  }

  return false;
}
