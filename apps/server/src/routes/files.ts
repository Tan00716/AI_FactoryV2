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

const WORKSPACE_ROOT = resolve(process.cwd());
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB — prototype cap
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'out', '__pycache__']);

/** Confine a relative path to the workspace tree. Returns absolute path. */
function resolveWorkspacePath(raw: string | undefined | null): string {
  const abs = resolve(WORKSPACE_ROOT, raw ?? '.');
  const rel = relative(WORKSPACE_ROOT, abs);
  if (rel === '..' || rel.startsWith(`..${'/'}`)) {
    throw new Error(`path must stay inside the workspace (${WORKSPACE_ROOT})`);
  }
  return abs;
}

function relOf(abs: string): string {
  return relative(WORKSPACE_ROOT, abs) || '.';
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

  // POST /api/file  {path, content}
  if (path === '/api/file' && method === 'POST') {
    const body = await ctx.readBody(req);
    const rel = body['path'] as string | undefined;
    const content = body['content'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    if (!rel || typeof content !== 'string') {
      ctx.json(res, 400, { error: 'path and content are required' });
      return true;
    }
    let file: string;
    try {
      file = resolveWorkspacePath(rel);
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
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
    ctx.json(res, 200, { ok: true, path: relOf(file) });
    return true;
  }

  return false;
}
