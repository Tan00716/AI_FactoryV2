/**
 * Project-wide text search routes (round-5 task R5-A8) — the backend for
 * the desktop Search Editor (`.code-search` files).
 *
 *   POST /api/codesearch/search  { root?, query, regex?, caseSensitive?, glob?, maxMatches? }
 *     → { query, groups: [{ file, matches: [{ line, column, text }] }],
 *         totalMatches, stats: { filesScanned, linesScanned, skippedBinary,
 *         skippedTooLarge, truncated, durationMs } }
 *
 * Index-free grep: no index is built, stored, or refreshed — the walk
 * happens on demand against the files as they are right now (still a
 * snapshot; nothing watches the filesystem between runs). This is why
 * the feature does not duplicate the codeindex agent index.
 *
 * The scan root is jailed by the injected resolver (the same
 * resolveInspectionRoot(FACTORY_INSPECT_ROOTS, default cwd) as the
 * quality-gate security scan / TODO tracker / trojan checker): outside
 * the allowed roots → 403. Ignored paths are pruned by the two-tier
 * ignore gate (forIndex=true, same as the code index).
 *
 * RBAC: the centralized prefix rule (auth.ts requiredRoleFor) maps
 * POST → operator for this prefix — searching walks the workspace
 * filesystem, so operator-only is the right floor. No auth.ts change.
 *
 * Auditing: searches are read-only; like the flaky GET and the TODO
 * scan, the search itself is not audited.
 *
 * The route must not value-import ../inspections (dual-mode import
 * rule: this module is imported from src by tests, so no extensionless
 * value-imports of sibling modules) — the root resolver arrives by
 * setter injection, trojan/A4 pattern:
 *
 *   import { handleCodeSearchRoutes, setCodeSearchRootResolver } from './routes/codesearch';
 *   ...
 *   setCodeSearchRootResolver((root) => resolveInspectionRoot(root));
 *   setCodeSearchIgnoreCheck((root, abs, isDir) => isIgnoredSync(root, abs, true, isDir));
 *   ...
 *   if (await handleCodeSearchRoutes(req, res, url, routeCtx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CodeSearchError,
  grepProject,
  type CodeSearchOptions,
  type CodeSearchQuery,
} from '@ai-factory/codesearch';
import type { RouteContext } from './context';

const PREFIX = '/api/codesearch';

/** Inspection-root resolver (setter injection, trojan/A4 pattern). */
let rootResolver: ((root?: string) => string) | null = null;

export function setCodeSearchRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}

/**
 * Ignore predicate (setter injection — same reason as the root
 * resolver: this module is imported from src by tests under
 * type-stripping, so it must not value-import ../ignore-gate).
 * The coordinator wires the two-tier ignore gate here:
 *
 *   setCodeSearchIgnoreCheck((root, abs, isDir) => isIgnoredSync(root, abs, true, isDir));
 */
let ignoreCheck: ((root: string, abs: string, isDir: boolean) => boolean) | null = null;

export function setCodeSearchIgnoreCheck(
  fn: ((root: string, abs: string, isDir: boolean) => boolean) | null,
): void {
  ignoreCheck = fn;
}

function resolveRoot(raw: unknown): string {
  if (!rootResolver) throw new CodeSearchError('code search root resolver is not configured');
  const s = typeof raw === 'string' ? raw.trim() : '';
  return rootResolver(s ? s : undefined);
}

export async function handleCodeSearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== `${PREFIX}/search`) return false;
  if (method !== 'POST') return false;

  const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
  let root: string;
  try {
    root = resolveRoot(body['root']);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message });
    return true;
  }
  const input: CodeSearchQuery = {
    query: body['query'] as string,
    regex: body['regex'] === true,
    caseSensitive: body['caseSensitive'] === true,
    glob: Array.isArray(body['glob'])
      ? (body['glob'] as unknown[]).filter((g) => typeof g === 'string')
      : typeof body['glob'] === 'string'
        ? body['glob']
        : undefined,
    maxMatches: typeof body['maxMatches'] === 'number' ? body['maxMatches'] : undefined,
  };
  const opts: CodeSearchOptions = {
    ignore: ignoreCheck ? (abs, isDir) => ignoreCheck!(root, abs, isDir) : undefined,
  };
  try {
    const result = grepProject(root, input, opts);
    ctx.json(res, 200, {
      query: result.query,
      groups: result.groups,
      totalMatches: result.totalMatches,
      stats: result.stats,
    });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    const code = e instanceof CodeSearchError ? 400 : 500;
    ctx.json(res, code, { error: msg });
  }
  return true;
}
