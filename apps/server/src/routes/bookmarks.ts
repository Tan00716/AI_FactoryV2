/**
 * Mnemonic bookmarks — server routes (round-5 task R5-B9).
 *
 *   GET    /api/bookmarks?root=            list bookmarks for a root
 *   POST   /api/bookmarks                  add a bookmark
 *   PATCH  /api/bookmarks?id=&root=         rename / re-tag / re-mnemonic
 *   DELETE /api/bookmarks?id=&root=         remove a bookmark
 *   POST   /api/bookmarks/toggle           toggle a line bookmark (editor)
 *   POST   /api/bookmarks/resolve          resolve a bookmark (drift check)
 *
 * Persistence: AI_FACTORY_DATA_DIR/bookmarks.json, one file with per-root
 * sections ("per project root isolation" per the round-5 spec). Roots are
 * absolute paths jailed through the injected inspection-root resolver, the
 * same as every other jailed route. Bookmarked paths are jailed inside the
 * resolved root (403 on escape). Line bookmarks capture drift context from
 * the file at creation time; resolve() re-reads the file and reports
 * 'ok' | 'relocated' | 'drifted' — it never silently jumps to a wrong line.
 *
 * Dual-mode import rule (AGENTS.md): value-imports only node builtins and
 * @ai-factory/bookmarks; the data-dir root and root jail come via setter
 * injection wired in apps/server/src/index.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  addBookmark,
  normalizePath,
  relocateLine,
  removeBookmark,
  updateBookmark,
  type Bookmark,
} from '@ai-factory/bookmarks';

const PREFIX = '/api/bookmarks';
const FILE_NAME = 'bookmarks.json';
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;

class BookmarkRouteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BookmarkRouteError';
    this.status = status;
  }
}

let rootResolver: ((root?: string) => string) | null = null;
export function setBookmarkInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}
let dataDirResolver: (() => string) | null = null;
export function setBookmarkDataDirResolver(fn: (() => string) | null): void {
  dataDirResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!rootResolver) throw new BookmarkRouteError('inspection root resolver is not wired', 500);
  try {
    return rootResolver(rawRoot);
  } catch (e) {
    throw new BookmarkRouteError((e as Error).message, 403);
  }
}

function dataFile(): string {
  if (!dataDirResolver) throw new BookmarkRouteError('data-dir resolver is not wired', 500);
  return join(dataDirResolver(), FILE_NAME);
}

/** Jail a root-relative bookmark path inside the resolved root. */
function jailPath(root: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new BookmarkRouteError('path is required');
  }
  const rel = normalizePath(raw);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new BookmarkRouteError(`path escapes the project root: ${raw.slice(0, 80)}`, 403);
  }
  return rel;
}

interface StoreShape {
  version: 1;
  roots: Record<string, Bookmark[]>;
}

function readStore(): StoreShape {
  try {
    const raw = readFileSync(dataFile(), 'utf8');
    if (raw.length > MAX_FILE_BYTES) throw new BookmarkRouteError('bookmark store too large', 413);
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    if (parsed && typeof parsed === 'object' && parsed.roots && typeof parsed.roots === 'object') {
      return { version: 1, roots: parsed.roots as Record<string, Bookmark[]> };
    }
  } catch (e) {
    if (e instanceof BookmarkRouteError) throw e;
    // Missing or corrupt: start empty (fail-open read; a corrupt file is
    // replaced on the next successful write, never trusted).
  }
  return { version: 1, roots: {} };
}

/** Atomic write: tmp file + rename so a crash never leaves half a store. */
function writeStore(store: StoreShape): void {
  const file = dataFile();
  mkdirSync(dirname(file), { recursive: true });
  const payload = JSON.stringify(store);
  if (payload.length > MAX_FILE_BYTES) {
    throw new BookmarkRouteError('bookmark store too large (1MB cap)', 413);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, file);
}

function hashLines(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function readFileForContext(root: string, rel: string): string {
  const abs = join(root, rel);
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new BookmarkRouteError('bookmark target is not a file', 400);
    if (st.size > MAX_READ_BYTES) throw new BookmarkRouteError('file too large (2MB cap)', 413);
  } catch (e) {
    if (e instanceof BookmarkRouteError) throw e;
    throw new BookmarkRouteError('cannot read bookmark target file', 404);
  }
  return readFileSync(abs, 'utf8');
}

function sendError(res: ServerResponse, ctx: RouteContext, e: unknown): boolean {
  if (e instanceof BookmarkRouteError) {
    ctx.json(res, e.status, { error: e.message, code: 'bookmark-error' });
    return true;
  }
  ctx.json(res, 500, { error: 'internal bookmark error', code: 'bookmark-internal' });
  return true;
}

async function handleList(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const root = resolveRoot(url.searchParams.get('root') ?? undefined);
    const store = readStore();
    ctx.json(res, 200, { root, bookmarks: store.roots[root] ?? [] });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleAdd(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
    const rel = jailPath(root, body['path']);
    const input = {
      kind: body['kind'],
      path: rel,
      ...(body['line'] !== undefined ? { line: body['line'] } : {}),
      ...(body['mnemonic'] !== undefined ? { mnemonic: body['mnemonic'] } : {}),
      ...(body['label'] !== undefined ? { label: body['label'] } : {}),
      ...(body['tags'] !== undefined ? { tags: body['tags'] } : {}),
    };
    const store = readStore();
    const existing = store.roots[root] ?? [];
    let fileText: string | undefined;
    if (input.kind === 'line') {
      fileText = readFileForContext(root, rel);
    } else if (input.kind === 'dir') {
      const abs = join(root, rel);
      try {
        if (!statSync(abs).isDirectory()) throw new BookmarkRouteError('bookmark target is not a directory', 400);
      } catch (e) {
        if (e instanceof BookmarkRouteError) throw e;
        throw new BookmarkRouteError('cannot stat bookmark target directory', 404);
      }
    } else {
      readFileForContext(root, rel); // file kind must exist and be readable
    }
    const { bookmark, issues } = addBookmark({ existing, input: input as never, fileText, hashLines });
    if (!bookmark) {
      ctx.json(res, 400, { error: issues.join('; '), code: 'bookmark-invalid' });
      return true;
    }
    existing.push(bookmark);
    store.roots[root] = existing;
    writeStore(store);
    ctx.audit.record('human', 'BOOKMARK_ADDED', 'bookmarks', root, {
      id: bookmark.id, kind: bookmark.kind, path: bookmark.path,
    });
    ctx.json(res, 201, { bookmark });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handlePatch(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const id = url.searchParams.get('id');
    if (!id) throw new BookmarkRouteError('id query param is required');
    const root = resolveRoot(url.searchParams.get('root') ?? undefined);
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const patch: { label?: string; tags?: string[]; mnemonic?: string | null } = {};
    if (body['label'] !== undefined) patch.label = body['label'] as string;
    if (body['tags'] !== undefined) patch.tags = body['tags'] as string[];
    if (body['mnemonic'] !== undefined) patch.mnemonic = body['mnemonic'] as string | null;
    const store = readStore();
    const existing = store.roots[root] ?? [];
    const { bookmark, issues } = updateBookmark(existing, id, patch);
    if (!bookmark) {
      ctx.json(res, issues[0] === 'bookmark not found' ? 404 : 400, {
        error: issues.join('; '), code: 'bookmark-invalid',
      });
      return true;
    }
    store.roots[root] = existing;
    writeStore(store);
    ctx.audit.record('human', 'BOOKMARK_UPDATED', 'bookmarks', root, { id });
    ctx.json(res, 200, { bookmark });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleDelete(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const id = url.searchParams.get('id');
    if (!id) throw new BookmarkRouteError('id query param is required');
    const root = resolveRoot(url.searchParams.get('root') ?? undefined);
    const store = readStore();
    const existing = store.roots[root] ?? [];
    const removed = removeBookmark(existing, id);
    if (!removed) {
      ctx.json(res, 404, { error: 'bookmark not found', code: 'bookmark-not-found' });
      return true;
    }
    store.roots[root] = existing;
    writeStore(store);
    ctx.audit.record('human', 'BOOKMARK_REMOVED', 'bookmarks', root, { id });
    ctx.json(res, 200, { ok: true, removed: removed.id });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleToggle(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  // Editor one-shot: toggle the line bookmark at (path, line). Returns
  // { added: true, bookmark } or { added: false }.
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
    const rel = jailPath(root, body['path']);
    const line = body['line'];
    if (!Number.isInteger(line) || (line as number) < 1) {
      throw new BookmarkRouteError('line must be a 1-based integer');
    }
    const store = readStore();
    const existing = store.roots[root] ?? [];
    const hit = existing.find((b) => b.kind === 'line' && b.path === rel && b.line === line);
    if (hit) {
      removeBookmark(existing, hit.id);
      store.roots[root] = existing;
      writeStore(store);
      ctx.audit.record('human', 'BOOKMARK_REMOVED', 'bookmarks', root, { id: hit.id });
      ctx.json(res, 200, { added: false, removedId: hit.id });
      return true;
    }
    const fileText = readFileForContext(root, rel);
    const { bookmark, issues } = addBookmark({
      existing, input: { kind: 'line', path: rel, line: line as number }, fileText, hashLines,
    });
    if (!bookmark) {
      ctx.json(res, 400, { error: issues.join('; '), code: 'bookmark-invalid' });
      return true;
    }
    existing.push(bookmark);
    store.roots[root] = existing;
    writeStore(store);
    ctx.audit.record('human', 'BOOKMARK_ADDED', 'bookmarks', root, {
      id: bookmark.id, kind: 'line', path: rel, line,
    });
    ctx.json(res, 201, { added: true, bookmark });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleResolve(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const id = body['id'];
    if (typeof id !== 'string' || !id) throw new BookmarkRouteError('id is required');
    const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
    const store = readStore();
    const bookmark = (store.roots[root] ?? []).find((b) => b.id === id);
    if (!bookmark) {
      ctx.json(res, 404, { error: 'bookmark not found', code: 'bookmark-not-found' });
      return true;
    }
    if (bookmark.kind === 'dir') {
      ctx.json(res, 200, { bookmark, status: 'ok', path: bookmark.path });
      return true;
    }
    // The target must still exist inside the jail; readFileForContext
    // re-jails and 404s honestly when it is gone.
    const text = readFileForContext(root, bookmark.path);
    if (bookmark.kind === 'file') {
      ctx.json(res, 200, { bookmark, status: 'ok', path: bookmark.path });
      return true;
    }
    const relocation = relocateLine(text, bookmark, hashLines);
    ctx.json(res, 200, {
      bookmark,
      status: relocation.status,
      path: bookmark.path,
      line: relocation.line,
      drifted: relocation.status === 'drifted',
    });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

export async function handleBookmarkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  try {
    if (req.method === 'GET' && (rest === '' || rest === '/')) return handleList(res, url, ctx);
    if (req.method === 'POST' && rest === '/toggle') return handleToggle(req, res, ctx);
    if (req.method === 'POST' && rest === '/resolve') return handleResolve(req, res, ctx);
    if (req.method === 'POST' && (rest === '' || rest === '/')) return handleAdd(req, res, ctx);
    if (req.method === 'PATCH' && (rest === '' || rest === '/')) return handlePatch(req, res, url, ctx);
    if (req.method === 'DELETE' && (rest === '' || rest === '/')) return handleDelete(res, url, ctx);
    ctx.json(res, 404, { error: 'unknown bookmarks route', code: 'not-found' });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}
