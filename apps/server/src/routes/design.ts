/**
 * Design-mode routes — Visual Design Mode (v0 Design Mode style):
 *
 *   GET  /api/design/info?path=<rel>   tailwind detection + file exists (viewer)
 *   POST /api/design/locate            {fingerprint, path?} → {found, file, line, column, text, classes} (operator)
 *   POST /api/design/apply             {path, line, fingerprint, edits} → write-back (operator)
 *
 * Fingerprints come from an untrusted preview DOM, so they are treated
 * as untrusted input: strictly validated, used ONLY for string
 * comparison during locate — never rendered, executed, or logged raw.
 *
 * apply path: re-locate on disk → drift guard (the element must still
 * sit at the requested line) → shadow checkpoint (undo) → write through
 * the same confined write the editor uses (POST /api/file semantics:
 * workspace jail + control-plane data dir refused). If the checkpoint
 * cannot be created the write is REFUSED — no undo, no write.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET →
 * viewer, POST → operator for this prefix — no auth.ts change needed.
 * Audit: DESIGN_MODE_EDIT / DESIGN_MODE_EDIT_FAILED.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  applyStyleEdits,
  classTokenFamily,
  detectTailwind,
  locateElement,
  type ElementFingerprint,
  type StyleEdits,
} from '../design-mode';
import { createShadowCheckpoint } from '../shadow-checkpoints';
import { shadowCheckpointStore } from './shadow';

const PREFIX = '/api/design';
const WORKSPACE_ROOT = resolve(process.cwd());
const MAX_FILE_BYTES = 1024 * 1024;
const CONTROL_DATA_DIR = dirname(resolve(process.env.DB_PATH ?? './data/factory.db'));
const SOURCE_EXTS = new Set(['.html', '.htm', '.jsx', '.tsx', '.vue']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'out', '__pycache__', 'data']);

function hitsControlDir(abs: string): boolean {
  return abs === CONTROL_DATA_DIR || abs.startsWith(CONTROL_DATA_DIR + sep);
}

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

function readSourceFile(abs: string): string | null {
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  if (statSync(abs).size > MAX_FILE_BYTES) return null;
  const buf = readFileSync(abs);
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

/** Fingerprint validation — strict, because it arrives from a preview DOM. */
export function fingerprintOf(v: unknown): ElementFingerprint | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const tag = o['tag'];
  if (typeof tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/.test(tag)) return null;
  const classesRaw = o['classes'];
  if (!Array.isArray(classesRaw) || classesRaw.length > 64) return null;
  const classes: string[] = [];
  for (const c of classesRaw) {
    if (typeof c !== 'string' || c.length === 0 || c.length > 128 || /[\s"'<>]/.test(c)) return null;
    classes.push(c);
  }
  const text = o['text'];
  if (typeof text !== 'string' || text.length > 500) return null;
  return { tag: tag.toLowerCase(), classes, text: text.trim() };
}

/** Validate each offered token against its family — the UI's promise is enforced server-side. */
function editsOf(v: unknown): StyleEdits | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const edits: StyleEdits = {};
  const token = (key: string, family: 'bg-color' | 'text-color' | 'text-size' | 'padding' | 'margin') => {
    const val = o[key];
    if (val === undefined) return true;
    if (typeof val !== 'string' || classTokenFamily(val) !== family) return false;
    (edits as Record<string, string>)[key] = val;
    return true;
  };
  if (!token('bgColor', 'bg-color')) return null;
  if (!token('textColor', 'text-color')) return null;
  if (!token('fontSize', 'text-size')) return null;
  if (!token('padding', 'padding')) return null;
  if (!token('margin', 'margin')) return null;
  if (o['text'] !== undefined) {
    if (typeof o['text'] !== 'string' || o['text'].length > 2000 || o['text'].includes('\0')) return null;
    edits.text = o['text'];
  }
  if (Object.keys(edits).length === 0) return null;
  return edits;
}

/** Bounded workspace walk for the locate scan (no explicit file given). */
function candidateSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 200) return;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow symlinks (shadow-checkpoint posture)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || hitsControlDir(abs)) continue;
        walk(abs, depth + 1);
      } else if (e.isFile() && SOURCE_EXTS.has(extname(e.name).toLowerCase())) {
        out.push(abs);
      }
    }
  };
  walk(WORKSPACE_ROOT, 0);
  return out.sort();
}

function tailwindInfo(): { tailwind: boolean; reason: string } {
  let packageJson: string | null = null;
  const pjPath = join(WORKSPACE_ROOT, 'package.json');
  if (existsSync(pjPath)) {
    try {
      packageJson = readFileSync(pjPath, 'utf8').slice(0, 256 * 1024);
    } catch {
      packageJson = null;
    }
  }
  let rootNames: string[] = [];
  try {
    rootNames = readdirSync(WORKSPACE_ROOT);
  } catch {
    rootNames = [];
  }
  const configFiles = rootNames.filter((n) => /^tailwind\.config\./.test(n));
  const cssSamples: string[] = [];
  const cssNames: string[] = [];
  const collectCss = (dir: string, depth: number): void => {
    if (depth > 3 || cssSamples.length >= 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (cssSamples.length >= 8) return;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        collectCss(abs, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.css')) {
        cssNames.push(abs);
        try {
          cssSamples.push(readFileSync(abs, 'utf8').slice(0, 64 * 1024));
        } catch {
          /* unreadable css is not a signal */
        }
      }
    }
  };
  collectCss(WORKSPACE_ROOT, 0);
  return detectTailwind({ packageJson, configFiles, cssSamples });
}

export async function handleDesignRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;

  // GET /api/design/info?path=<rel>
  if (path === `${PREFIX}/info` && method === 'GET') {
    let abs: string;
    try {
      abs = resolveWorkspacePath(url.searchParams.get('path'));
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    if (hitsControlDir(abs)) {
      ctx.json(res, 403, { error: 'path refused: control-plane data directory' });
      return true;
    }
    const tw = tailwindInfo();
    ctx.json(res, 200, {
      path: relOf(abs),
      exists: existsSync(abs) && statSync(abs).isFile(),
      tailwind: tw.tailwind,
      tailwindReason: tw.reason,
    });
    return true;
  }

  // POST /api/design/locate {fingerprint, path?}
  if (path === `${PREFIX}/locate` && method === 'POST') {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const fp = fingerprintOf(body?.['fingerprint']);
    if (!fp) {
      ctx.json(res, 400, { error: 'invalid fingerprint', code: 'DESIGN_BAD_FINGERPRINT' });
      return true;
    }
    const explicit = typeof body?.['path'] === 'string' ? (body['path'] as string) : null;
    if (explicit) {
      let abs: string;
      try {
        abs = resolveWorkspacePath(explicit);
      } catch (err) {
        ctx.json(res, 403, { error: (err as Error).message });
        return true;
      }
      if (hitsControlDir(abs) || !SOURCE_EXTS.has(extname(abs).toLowerCase())) {
        ctx.json(res, 400, { error: 'path is not a locatable source file', code: 'DESIGN_BAD_PATH' });
        return true;
      }
      const content = readSourceFile(abs);
      if (content === null) {
        ctx.json(res, 404, { error: `file not found or unreadable: ${relOf(abs)}` });
        return true;
      }
      const hit = locateElement(content, fp);
      ctx.json(res, 200, {
        found: hit !== null,
        file: hit ? relOf(abs) : null,
        line: hit?.line ?? null,
        column: hit?.column ?? null,
        text: hit?.text ?? null,
        classes: hit?.classes ?? [],
      });
      return true;
    }
    // Scan mode: best hit across the workspace's source files.
    let best: { abs: string; line: number; column: number; text: string | null; classes: string[]; score: number } | null =
      null;
    for (const abs of candidateSourceFiles()) {
      const content = readSourceFile(abs);
      if (content === null) continue;
      const hit = locateElement(content, fp);
      if (!hit) continue;
      const matched = fp.classes.filter((c) => hit.classes.includes(c)).length;
      const score = (fp.classes.length ? matched / fp.classes.length : 0) + (fp.text && hit.text ? 2 : 0);
      if (!best || score > best.score) {
        best = { abs, line: hit.line, column: hit.column, text: hit.text, classes: hit.classes, score };
      }
    }
    ctx.json(res, 200, {
      found: best !== null,
      file: best ? relOf(best.abs) : null,
      line: best?.line ?? null,
      column: best?.column ?? null,
      text: best?.text ?? null,
      classes: best?.classes ?? [],
    });
    return true;
  }

  // POST /api/design/apply {path, line, fingerprint, edits}
  if (path === `${PREFIX}/apply` && method === 'POST') {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const rawPath = typeof body?.['path'] === 'string' ? (body['path'] as string) : null;
    const line = typeof body?.['line'] === 'number' ? (body['line'] as number) : NaN;
    const fp = fingerprintOf(body?.['fingerprint']);
    const edits = editsOf(body?.['edits']);
    if (!rawPath || !Number.isInteger(line) || line < 1 || !fp || !edits) {
      ctx.json(res, 400, { error: 'path, line, fingerprint and non-empty edits are required', code: 'DESIGN_BAD_REQUEST' });
      return true;
    }
    let abs: string;
    try {
      abs = resolveWorkspacePath(rawPath);
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    if (hitsControlDir(abs)) {
      ctx.json(res, 403, { error: 'path refused: control-plane data directory' });
      return true;
    }
    const ext = extname(abs).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) {
      ctx.json(res, 400, { error: 'not an editable web source file', code: 'DESIGN_BAD_PATH' });
      return true;
    }
    const content = readSourceFile(abs);
    if (content === null) {
      ctx.json(res, 404, { error: `file not found or unreadable: ${relOf(abs)}` });
      return true;
    }
    const jsx = ext === '.jsx' || ext === '.tsx' || ext === '.vue';
    const result = applyStyleEdits(content, fp, line, edits, jsx);
    if ('error' in result) {
      const drift = result.error.startsWith('drift');
      ctx.audit.record('human', 'DESIGN_MODE_EDIT_FAILED', 'design', relOf(abs), {
        line,
        reason: result.error,
      });
      ctx.json(res, drift ? 409 : 422, { error: result.error, code: drift ? 'DESIGN_DRIFT' : 'DESIGN_APPLY_FAILED' });
      return true;
    }
    if (result.content === content) {
      ctx.json(res, 200, { ok: true, changed: false, file: relOf(abs), line, checkpointId: null });
      return true;
    }
    // Undo first: a shadow checkpoint of the workspace BEFORE the write.
    // If it cannot be created we refuse the write (fail-closed posture).
    let checkpointId: string;
    try {
      const cp = createShadowCheckpoint(shadowCheckpointStore(), {
        workspaceId: 'design-mode',
        workspacePath: WORKSPACE_ROOT,
        label: `design edit ${relOf(abs)}`,
      });
      checkpointId = cp.id;
    } catch (err) {
      ctx.audit.record('human', 'DESIGN_MODE_EDIT_FAILED', 'design', relOf(abs), {
        line,
        reason: `checkpoint failed: ${(err as Error).message}`,
      });
      ctx.json(res, 503, {
        error: `shadow checkpoint unavailable; write refused: ${(err as Error).message}`,
        code: 'DESIGN_CHECKPOINT_UNAVAILABLE',
      });
      return true;
    }
    writeFileSync(abs, result.content, 'utf8');
    ctx.audit.record('human', 'DESIGN_MODE_EDIT', 'design', relOf(abs), {
      line,
      applied: result.applied,
      checkpointId,
    });
    ctx.json(res, 200, {
      ok: true,
      changed: true,
      file: relOf(abs),
      line,
      applied: result.applied,
      checkpointId,
    });
    return true;
  }

  return false;
}
