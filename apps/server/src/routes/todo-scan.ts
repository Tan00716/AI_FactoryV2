/**
 * TODO tracker routes (round-4 task B9) — JetBrains TODO tool-window style.
 *
 *   GET  /api/todos?root=          config + full scan results (viewer)
 *   GET  /api/todos/file?path=&root=  items for one file (viewer; gutter)
 *   PUT  /api/todos                {root?, patterns} — custom patterns (operator)
 *   POST /api/todos/reset          {root?} — restore defaults (operator)
 *
 * Scan root is jailed by resolveInspectionRoot() (FACTORY_INSPECT_ROOTS,
 * default: server cwd) — the same jail as the quality-gate security
 * scan. The two-tier ignore gate (@ai-factory/ignores) prunes ignored
 * paths from the walk. `path` on /api/todos/file is confined to the
 * resolved root; control-plane refuses are 403.
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 *
 * Audit: TODO_CONFIG_UPDATED / TODO_CONFIG_RESET. Scans themselves are
 * read-only and not audited (same posture as the flaky GET).
 *
 * Config is in-memory per resolved root (session-scoped; a restart
 * restores defaults — the UI says so). Deterministic: sorted walk,
 * config-order patterns, ascending lines.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleTodoScanRoutes } from './routes/todo-scan';
 *   if (await handleTodoScanRoutes(req, res, url, routeCtx)) return;
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Regex-based, not comment-aware: a TODO in a string literal matches
 *    like one in a comment. Case-sensitive. Results are a snapshot.
 *  - Custom patterns run un-sandboxed in the server process; validated
 *    (length-capped, must compile, must not match the empty string) but
 *    a hostile pattern is the operator's own foot-gun.
 */
import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { resolve, sep } from 'node:path';
import { isIgnoredSync } from '../ignore-gate';
import { resolveInspectionRoot } from '../inspections';
import {
  DEFAULT_TODO_PATTERNS,
  TodoScanError,
  scanTodoFile,
  scanTodos,
  validateTodoPatterns,
  type TodoPattern,
} from '../todo-scan';
import type { RouteContext } from './context';

const PREFIX = '/api/todos';

/** Session-scoped custom patterns, keyed by resolved root. */
const configStore = new Map<string, TodoPattern[]>();

function patternsFor(root: string): TodoPattern[] {
  return configStore.get(root) ?? DEFAULT_TODO_PATTERNS;
}

function rootOf(url: URL): string {
  const raw = url.searchParams.get('root') ?? '';
  return resolveInspectionRoot(raw.trim() ? raw : undefined);
}

/** Confine a workspace-relative path to the resolved root. */
function jailFile(root: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new TodoScanError('path is required');
  }
  const abs = resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new TodoScanError(`path escapes the scan root: ${raw.slice(0, 80)}`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new TodoScanError(`path does not exist: ${raw.slice(0, 80)}`);
  }
  if (!st.isFile()) throw new TodoScanError(`path is not a file: ${raw.slice(0, 80)}`);
  return abs;
}

function ignorePredicate(root: string): (abs: string, isDir: boolean) => boolean {
  return (abs, isDir) => isIgnoredSync(root, abs, true, isDir);
}

function todoErrorStatus(e: unknown): number {
  const msg = (e as Error).message ?? '';
  if (/escapes|does not exist|not a file|outside the allowed roots/i.test(msg)) return 403;
  return 400;
}

export async function handleTodoScanRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== PREFIX && path !== `${PREFIX}/file` && path !== `${PREFIX}/reset`) return false;
  const method = req.method ?? 'GET';

  // GET /api/todos — config + full scan (viewer).
  if (method === 'GET' && path === PREFIX) {
    let root: string;
    try {
      root = rootOf(url);
    } catch (e) {
      ctx.json(res, 403, { error: (e as Error).message });
      return true;
    }
    const patterns = patternsFor(root);
    let scanned: ReturnType<typeof scanTodos>;
    try {
      scanned = scanTodos(root, { patterns, ignore: ignorePredicate(root) });
    } catch (e) {
      ctx.json(res, todoErrorStatus(e), { error: (e as Error).message });
      return true;
    }
    ctx.json(res, 200, { root, patterns, items: scanned.items, stats: scanned.stats });
    return true;
  }

  // GET /api/todos/file — items for one file (viewer; editor gutter).
  if (method === 'GET' && path === `${PREFIX}/file`) {
    let root: string;
    try {
      root = rootOf(url);
    } catch (e) {
      ctx.json(res, 403, { error: (e as Error).message });
      return true;
    }
    let abs: string;
    try {
      abs = jailFile(root, url.searchParams.get('path'));
    } catch (e) {
      ctx.json(res, todoErrorStatus(e), { error: (e as Error).message });
      return true;
    }
    const items = scanTodoFile(abs, root, patternsFor(root));
    ctx.json(res, 200, { root, items });
    return true;
  }

  // PUT /api/todos — custom patterns (operator).
  if (method === 'PUT' && path === PREFIX) {
    const body = await ctx.readBody(req);
    let root: string;
    try {
      const raw = body['root'];
      root = resolveInspectionRoot(typeof raw === 'string' && raw.trim() ? raw : undefined);
    } catch (e) {
      ctx.json(res, 403, { error: (e as Error).message });
      return true;
    }
    let patterns: TodoPattern[];
    try {
      patterns = validateTodoPatterns(body['patterns']);
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
      return true;
    }
    configStore.set(root, patterns);
    ctx.audit.record('operator', 'TODO_CONFIG_UPDATED', 'todo-scan', root, {
      patterns: patterns.map((p) => `${p.name}:${p.severity}:${p.enabled ? 'on' : 'off'}`),
    });
    ctx.json(res, 200, { root, patterns });
    return true;
  }

  // POST /api/todos/reset — restore defaults (operator).
  if (method === 'POST' && path === `${PREFIX}/reset`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    let root: string;
    try {
      const raw = (body as Record<string, unknown>)['root'];
      root = resolveInspectionRoot(typeof raw === 'string' && raw.trim() ? raw : undefined);
    } catch (e) {
      ctx.json(res, 403, { error: (e as Error).message });
      return true;
    }
    configStore.delete(root);
    ctx.audit.record('operator', 'TODO_CONFIG_RESET', 'todo-scan', root, {});
    ctx.json(res, 200, { root, patterns: DEFAULT_TODO_PATTERNS });
    return true;
  }

  return false;
}
