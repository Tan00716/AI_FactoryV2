/**
 * Workspace file routes — backs the Monaco editor (§65) in the desktop app.
 *
 *  GET  /api/files?root=<rel>   → list directory entries
 *  GET  /api/file?path=<rel>    → read a text file
 *  POST /api/file               {path, content} → write a text file
 *
 * All paths are confined to the server workspace root; binary files and
 * files over the size cap are refused.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleFileRoutes } from './routes/files';
 *   if (await handleFileRoutes(req, res, url, ctx)) return;
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import { canonicalPathIsInside, canonicalizePathSync } from '@ai-factory/security';
import {
  ScopeLockDeniedError,
  checkScopedWrite,
  hasScope,
  type TaskEditScope,
} from '../scope-lock';
import { snapshotOnSave, type SnapshotRecord } from '../local-history';

const WORKSPACE_ROOT = canonicalizePathSync(resolve(process.cwd()));
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB — prototype cap
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'out', '__pycache__']);

/**
 * SPEC §4.1 — control-plane data directory (same default as index.ts:
 * DB_PATH ?? './data/factory.db'). W-C P0 fix (H3-A4 probe): POST
 * /api/file had NO control-dir guard, so any local API caller could
 * overwrite data/factory.db (and secrets/, snapshots/, …) — full
 * database replacement, audit chain included. The binary-file check
 * on GET happened to block .db *reads*, but nothing blocked writes.
 * Both read and write now refuse the control-plane tree.
 * V3R19 #6(p): canonicalized — the guard must see through a symlink
 * inside the workspace that points at the control dir, exactly like
 * the exec argv guard (R19 N1 family).
 */
const CONTROL_DATA_DIR = canonicalizePathSync(dirname(resolve(process.env.DB_PATH ?? './data/factory.db')));

function hitsControlDir(abs: string): boolean {
  return abs === CONTROL_DATA_DIR || canonicalPathIsInside(abs, CONTROL_DATA_DIR);
}

/** Confine a relative path to the workspace tree. Returns absolute path. */
export function resolveWorkspacePath(raw: string | undefined | null): string {
  // V3R19 #6(p): decide on the canonical path — a path that is (or
  // sits under) a symlink to outside the workspace must be refused
  // exactly like the lexical path would be (same shape as
  // routes/exec.ts resolveCwd).
  const abs = canonicalizePathSync(resolve(WORKSPACE_ROOT, raw ?? '.'));
  const rel = relative(WORKSPACE_ROOT, abs);
  if (rel === '..' || rel.startsWith(`..${'/'}`)) {
    throw new Error(`path must stay inside the workspace (${WORKSPACE_ROOT})`);
  }
  return abs;
}

function relOf(abs: string): string {
  return relative(WORKSPACE_ROOT, abs) || '.';
}

/**
 * Task-attribution scope lookup, installed by the coordinator
 * (apps/server/src/index.ts) as a closure over RouteContext.tasks.
 * Setter injection: the module is imported straight from src by some
 * server tests, and scope-lock.ts is import-safe under node
 * type-stripping (node builtins + type-only core import), so this
 * indirection keeps files.ts importable either way — mirroring the
 * setBackupIgnoreCheck precedent in routes/backup.ts.
 */
let fileScopeLookup: ((taskId: string) => TaskEditScope | null | undefined) | null = null;

export function setFileScopeLookup(
  fn: ((taskId: string) => TaskEditScope | null | undefined) | null,
): void {
  fileScopeLookup = fn;
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GET /api/files?root=<rel>
  if (path === '/api/files' && method === 'GET') {
    let dir: string;
    try {
      dir = resolveWorkspacePath(url.searchParams.get('root'));
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      ctx.json(res, 404, { error: `directory not found: ${relOf(dir)}` });
      return true;
    }
    if (hitsControlDir(dir)) {
      ctx.json(res, 403, { error: `path refused: the control-plane data directory (${CONTROL_DATA_DIR}) is off-limits` });
      return true;
    }
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      .map((e) => ({
        name: e.name,
        path: relOf(resolve(dir, e.name)),
        type: e.isDirectory() ? 'dir' : ('file' as const),
      }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
    ctx.json(res, 200, { root: relOf(dir), workspaceRoot: WORKSPACE_ROOT, entries });
    return true;
  }

  // GET /api/file?path=<rel>
  if (path === '/api/file' && method === 'GET') {
    let file: string;
    try {
      file = resolveWorkspacePath(url.searchParams.get('path'));
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    if (hitsControlDir(file)) {
      ctx.json(res, 403, { error: `path refused: the control-plane data directory (${CONTROL_DATA_DIR}) is off-limits` });
      return true;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      ctx.json(res, 404, { error: `file not found: ${relOf(file)}` });
      return true;
    }
    const size = statSync(file).size;
    if (size > MAX_FILE_BYTES) {
      ctx.json(res, 413, { error: `file too large for the prototype editor (${size} bytes)` });
      return true;
    }
    const buf = readFileSync(file);
    if (buf.includes(0)) {
      ctx.json(res, 415, { error: 'binary files cannot be opened in the text editor' });
      return true;
    }
    ctx.json(res, 200, { path: relOf(file), size, content: buf.toString('utf8') });
    return true;
  }

  // POST /api/file  {path, content, taskId?}
  if (path === '/api/file' && method === 'POST') {
    const body = await ctx.readBody(req);
    const rel = body['path'] as string | undefined;
    const content = body['content'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    if (!rel || typeof content !== 'string') {
      ctx.json(res, 400, { error: 'path and content are required' });
      return true;
    }
    // Scope Lock （二轮加强 8) — a write ATTRIBUTED to a task
    // (taskId supplied) is checked against that task's edit scope
    // BEFORE it lands: out-of-scope → 403 SCOPE_LOCKED + SCOPE_VIOLATION
    // audit, nothing written, the run itself is not otherwise affected.
    // Manual editing in the editor never carries a taskId, so the
    // human's own file editing stays unrestricted — by design (the
    // lock constrains work done *for* a task, not the operator).
    // An unknown taskId is refused 404: attribution must be honest.
    const taskId =
      typeof body['taskId'] === 'string' && body['taskId'].trim()
        ? body['taskId'].trim()
        : null;
    let taskScope: TaskEditScope | null | undefined;
    if (taskId) {
      try {
        taskScope = fileScopeLookup ? fileScopeLookup(taskId) : null;
      } catch {
        ctx.json(res, 404, { error: `task not found: ${taskId}`, code: 'TASK_NOT_FOUND' });
        return true;
      }
    }
    let file: string;
    try {
      file = resolveWorkspacePath(rel);
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    if (hitsControlDir(file)) {
      const actor0 = (body['actor'] as string | undefined) ?? 'human';
      ctx.audit.record(actor0, 'FILE_WRITE_DENIED', 'file', relOf(file), {
        reason: 'control-plane data directory is off-limits',
      });
      ctx.json(res, 403, { error: `path refused: the control-plane data directory (${CONTROL_DATA_DIR}) is off-limits` });
      return true;
    }
    if (taskId && taskScope && hasScope(taskScope)) {
      try {
        checkScopedWrite(taskScope, WORKSPACE_ROOT, rel);
      } catch (e) {
        if (e instanceof ScopeLockDeniedError) {
          ctx.audit.record(actor, 'SCOPE_VIOLATION', 'file', relOf(file), {
            taskId,
            reason: e.reason,
            path: e.relPath,
            code: 'SCOPE_LOCKED',
            note: 'task-attributed write refused before landing (scope lock)',
          });
          ctx.json(res, 403, {
            error: e.message,
            code: 'SCOPE_LOCKED',
            reason: e.reason,
            path: e.relPath,
            taskId,
          });
          return true;
        }
        throw e;
      }
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      ctx.json(res, 413, { error: 'content exceeds the 1 MiB prototype cap' });
      return true;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    ctx.audit.record(actor, 'FILE_WRITE', 'file', relOf(file), {
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    // R3-T6 Local History: snapshot the saved content. The write has
    // already landed — a snapshot failure must never undo it, so the
    // snapshot is best-effort and its status is reported explicitly
    // (ok / skipped-unchanged / skipped-too-large / skipped-disabled /
    // skipped-error), mirroring the db-time-travel skip-and-say-plainly
    // convention.
    let localHistory: SnapshotRecord;
    try {
      localHistory = snapshotOnSave(WORKSPACE_ROOT, relOf(file), content, 'save');
    } catch (err) {
      localHistory = { status: 'skipped-error', id: null, reason: (err as Error).message, pruned: 0 };
    }
    ctx.json(res, 200, { ok: true, path: relOf(file), localHistory });
    return true;
  }

  return false;
}
