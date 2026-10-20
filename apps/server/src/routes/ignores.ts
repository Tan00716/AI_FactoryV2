/**
 * Two-tier ignore files — HTTP surface (task ②, second round).
 *
 *   GET /api/ignores?projectId=            file contents + layer state (viewer)
 *   PUT /api/ignores {projectId, hard?, indexing?}
 *                                          write .ai-factory/ignore /
 *                                          .ai-factory/indexing-ignore (operator)
 *   GET /api/ignores/preview?projectId=&limit=
 *                                          dry-run: which files the two
 *                                          layers currently exclude (viewer)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET → viewer
 * and other methods → operator for this prefix — no auth.ts change.
 *
 * Path policy: the project working directory comes from the project
 * record's `path` (ctx.fdb.getProject) and must stay inside the
 * operator-configured projects root (FACTORY_PROJECTS_ROOT, default
 * <dir of DB_PATH>/projects) — the same containment the backup module
 * enforces (Batch 47-2, finding F22). A record without a path gets a
 * 409, never a fabricated default.
 *
 * Audit: IGNORES_UPDATED on writes; IGNORE_LAYER_SKIPPED is emitted by
 * the gate itself (apps/server/src/ignore-gate.ts), wired in index.ts.
 *
 * HONEST BOUNDARY (surfaced in the UI copy too): the two tiers only
 * constrain the AI Factory surfaces that consult the gate — code index,
 * repo map, @-context providers, code search, backups. They do not stop
 * the OS, another tool, or the operator's own exec/terminal/editor from
 * reading a file. "Not indexed" (indexing tier) does NOT mean "invisible":
 * an indexing-ignored file can still be referenced explicitly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_HARD_IGNORE_TEMPLATE,
  HARD_IGNORE_FILE,
  INDEXING_IGNORE_FILE,
  MAX_IGNORE_FILE_BYTES,
} from '@ai-factory/ignores';
import type { RouteContext } from './context';
import { getIgnoreSet, ignoreVerdictSync } from '../ignore-gate';

const PREFIX = '/api/ignores';

const PREVIEW_WALK_CAP = 100_000;
const PREVIEW_LIST_CAP = 500;

function projectsRoot(): string {
  const raw = process.env['FACTORY_PROJECTS_ROOT'];
  if (raw && raw.trim()) return resolve(raw.trim());
  const dbPath = process.env['DB_PATH'] ?? './data/factory.db';
  return join(dirname(resolve(dbPath)), 'projects');
}

/** Resolve + jail the project working directory from its record. */
function resolveProjectDir(
  ctx: RouteContext,
  projectId: string,
): { ok: true; dir: string } | { ok: false; status: number; error: string; code: string } {
  const p = ctx.fdb.getProject(projectId);
  if (!p) {
    return { ok: false, status: 404, error: `project not found: ${projectId}`, code: 'PROJECT_NOT_FOUND' };
  }
  const raw = (p.path ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      status: 409,
      error: 'project has no local working directory (path is empty); ignore files live in the project directory',
      code: 'IGNORE_NO_PROJECT_PATH',
    };
  }
  const abs = resolve(raw);
  const root = projectsRoot();
  if (!(abs === root || abs.startsWith(root + sep))) {
    return {
      ok: false,
      status: 403,
      error: `project path escapes the projects root (${root}): ${abs}`,
      code: 'IGNORE_PATH_OUTSIDE_ROOT',
    };
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { ok: false, status: 404, error: `project directory does not exist: ${abs}`, code: 'PROJECT_DIR_NOT_FOUND' };
  }
  return { ok: true, dir: abs };
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

/** Raw file text for the editor; '' when absent/unreadable (state errors
 *  surface via the gate's errors() in the same response). */
function readFileOrEmpty(file: string): string {
  try {
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function stateResponse(ctx: RouteContext, res: ServerResponse, projectId: string, dir: string): true {
  const set = getIgnoreSet(dir);
  ctx.json(res, 200, {
    projectId,
    projectPath: dir,
    hard: readFileOrEmpty(join(dir, HARD_IGNORE_FILE)),
    indexing: readFileOrEmpty(join(dir, INDEXING_IGNORE_FILE)),
    hardPatterns: set.hardPatternCount(),
    indexingPatterns: set.indexingPatternCount(),
    errors: set.errors().map((e) => ({ layer: e.layer, file: e.file, message: e.message })),
    template: DEFAULT_HARD_IGNORE_TEMPLATE,
  });
  return true;
}

interface PreviewEntry {
  rel: string;
  pattern: string;
  line: number;
}

function previewWalk(dir: string, limit: number): {
  total: number;
  visited: number;
  truncated: boolean;
  hardIgnored: PreviewEntry[];
  indexingIgnored: PreviewEntry[];
} {
  const hardIgnored: PreviewEntry[] = [];
  const indexingIgnored: PreviewEntry[] = [];
  let visited = 0;
  let truncated = false;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (truncated) break;
    const cur = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (visited >= PREVIEW_WALK_CAP) {
        truncated = true;
        break;
      }
      visited += 1;
      const full = join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      const isDir = e.isDirectory();
      const hard = ignoreVerdictSync(dir, full, false, isDir);
      if (hard.ignored) {
        if (hardIgnored.length < limit) {
          hardIgnored.push({
            rel: relative(dir, full).split(sep).join('/'),
            pattern: hard.pattern ?? '',
            line: hard.line ?? 0,
          });
        }
      } else if (!isDir) {
        const idx = ignoreVerdictSync(dir, full, true, false);
        if (idx.ignored && idx.layer === 'indexing') {
          if (indexingIgnored.length < limit) {
            indexingIgnored.push({
              rel: relative(dir, full).split(sep).join('/'),
              pattern: idx.pattern ?? '',
              line: idx.line ?? 0,
            });
          }
        }
      }
      if (isDir) stack.push(full);
    }
  }
  return {
    total: hardIgnored.length + indexingIgnored.length,
    visited,
    truncated,
    hardIgnored,
    indexingIgnored,
  };
}

export async function handleIgnoresRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/ignores/preview?projectId=&limit=
  if (method === 'GET' && path === `${PREFIX}/preview`) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const resolved = resolveProjectDir(ctx, projectId);
    if (!resolved.ok) {
      ctx.json(res, resolved.status, { error: resolved.error, code: resolved.code });
      return true;
    }
    const limit = Math.min(PREVIEW_LIST_CAP, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const out = previewWalk(resolved.dir, limit);
    ctx.json(res, 200, {
      projectId,
      projectPath: resolved.dir,
      ...out,
      note: 'dry-run over ignore-file verdicts only; .gitignore and built-in skips are not applied here',
    });
    return true;
  }

  // GET /api/ignores?projectId=
  if (method === 'GET' && path === PREFIX) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const resolved = resolveProjectDir(ctx, projectId);
    if (!resolved.ok) {
      ctx.json(res, resolved.status, { error: resolved.error, code: resolved.code });
      return true;
    }
    return stateResponse(ctx, res, projectId, resolved.dir);
  }

  // PUT /api/ignores {projectId, hard?, indexing?}
  if (method === 'PUT' && path === PREFIX) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const resolved = resolveProjectDir(ctx, projectId);
    if (!resolved.ok) {
      ctx.json(res, resolved.status, { error: resolved.error, code: resolved.code });
      return true;
    }
    const dir = resolved.dir;
    const writes: { file: string; text: string; layer: string }[] = [];
    for (const [key, fileName] of [
      ['hard', HARD_IGNORE_FILE],
      ['indexing', INDEXING_IGNORE_FILE],
    ] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') {
        ctx.json(res, 400, { error: `${key} must be a string`, code: 'IGNORE_TEXT_INVALID' });
        return true;
      }
      if (v.length > MAX_IGNORE_FILE_BYTES || v.includes('\0')) {
        ctx.json(res, 400, {
          error: `${key} exceeds the ${MAX_IGNORE_FILE_BYTES}-byte cap or contains NUL bytes`,
          code: 'IGNORE_TEXT_INVALID',
        });
        return true;
      }
      writes.push({ file: join(dir, fileName), text: v, layer: key });
    }
    if (writes.length === 0) {
      ctx.json(res, 400, { error: 'nothing to write: provide hard and/or indexing', code: 'IGNORE_TEXT_INVALID' });
      return true;
    }
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    for (const w of writes) {
      const tmp = `${w.file}.${process.pid}.tmp`;
      writeFileSync(tmp, w.text, 'utf8');
      renameSync(tmp, w.file);
    }
    ctx.audit.record('server', 'IGNORES_UPDATED', 'project', projectId, {
      projectPath: dir,
      layers: writes.map((w) => w.layer),
    });
    return stateResponse(ctx, res, projectId, dir);
  }

  return false;
}
