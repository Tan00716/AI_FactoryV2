/**
 * Structural search-and-replace routes (round-4 task R4-A4) — JetBrains-SSR style.
 *
 *   GET  /api/ssr/templates            → { builtins, saved } (viewer)
 *   POST /api/ssr/templates            { template } → { template } (operator, audited)
 *   DELETE /api/ssr/templates/:id      → { deleted } (operator, audited)
 *   POST /api/ssr/search               { root?, template } → { matches } (operator)
 *   POST /api/ssr/preview              { root?, template, only? } → { files, skipped } (operator)
 *   POST /api/ssr/apply                { root?, template, only? } → { applied, skipped, filesChanged } (operator, audited)
 *   POST /api/ssr/quickfix             { root?, templateId, file, startLine } → { applied, diff } (operator, audited)
 *
 * `template` in search/preview/apply may be a full template object or
 * `{ "id": "<builtin-or-saved-id>" }`.
 *
 * Inspection-root resolver is injected by the coordinator (setter-injection
 * pattern: routes/ssr must not value-import ../inspections, so that
 * direct type-stripping tests keep working — AGENTS.md dual-mode rule).
 * The coordinator wires the real resolveInspectionRoot in index.ts, plus
 * the SSR inspection checker via setExtraCheckerProvider.
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 *
 * Audit: SSR_TEMPLATE_SAVED / SSR_TEMPLATE_DELETED / SSR_TEMPLATE_APPLIED /
 * SSR_QUICKFIX_APPLIED.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - The "AST" is a heuristic line-oriented scan (see @ai-factory/ssr
 *    types.ts), not a compiler frontend. TS/JS only. Decorators,
 *    computed method names, and object-literal methods are missed.
 *  - Rename is scope-limited, not true scope analysis: a shadowed
 *    same-name symbol in a nested scope is renamed together with the
 *    target. The preview diff always shows exactly what will change —
 *    review it before applying.
 *  - apply/quickfix write files directly (explicit operator action =
 *    human approval). There is no undo besides the editor's own
 *    Local History snapshots.
 *  - Search is capped: 2000 files / 200KB per file; over the cap the
 *    response is 400 SSR_LIMITS (fail-closed, never silently partial).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, sep, extname, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import type { Checker, Finding } from '../inspections';
import {
  validateTemplate,
  findMatches,
  previewEdits,
  applyEdits,
  builtinTemplates,
  builtinTemplateById,
  ssrSupportedExtensions,
} from '@ai-factory/ssr';
import type { SsrMatch, SsrTemplate } from '@ai-factory/ssr';

const PREFIX = '/api/ssr';
const TEMPLATES_FILE = join('.ai-factory', 'ssr-templates.json');
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 200 * 1024;
const SOURCE_EXTS = new Set(ssrSupportedExtensions());
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', '__pycache__', 'target']);

export class SsrRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrRouteError';
  }
}

// ---------------------------------------------------------------------------
// Inspection-root resolver (setter injection)
// ---------------------------------------------------------------------------

let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setSsrInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!inspectionRootResolver) {
    throw new SsrRouteError('inspection root resolver is not wired');
  }
  try {
    return inspectionRootResolver(rawRoot);
  } catch (e) {
    throw new SsrRouteError((e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Template storage (.ai-factory/ssr-templates.json, atomic writes)
// ---------------------------------------------------------------------------

interface TemplateStore {
  version: 1;
  templates: SsrTemplate[];
}

function templatesPath(root: string): string {
  return join(root, TEMPLATES_FILE);
}

export function loadSavedTemplates(root: string): SsrTemplate[] {
  const fp = templatesPath(root);
  if (!existsSync(fp)) return [];
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as Partial<TemplateStore>;
    if (raw.version !== 1 || !Array.isArray(raw.templates)) return [];
    const out: SsrTemplate[] = [];
    for (const t of raw.templates) {
      const { template, errors } = validateTemplate(t);
      if (template && errors.length === 0) out.push(template);
      // A corrupt entry is skipped, never fatal (loudly counted by caller).
    }
    return out;
  } catch {
    return [];
  }
}

function saveTemplates(root: string, templates: SsrTemplate[]): void {
  const fp = templatesPath(root);
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, templates }, null, 2));
  renameSync(tmp, fp);
}

/** Resolve a template reference: full object or { id } (builtin or saved). */
function resolveTemplate(root: string, ref: unknown): SsrTemplate {
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
    const rec = ref as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (!(keys.length === 1 && keys[0] === 'id')) {
      const { template, errors } = validateTemplate(ref);
      if (!template || errors.length > 0) {
        throw new SsrRouteError(`invalid template: ${errors.join('; ')}`.slice(0, 300));
      }
      return template;
    }
    // bare { id } reference → look up builtin / saved below
  }
  const id = (ref as Record<string, unknown>)?.id;
  if (typeof id !== 'string') throw new SsrRouteError('template must be an object or { id }');
  const builtin = builtinTemplateById(id);
  if (builtin) return builtin;
  const saved = loadSavedTemplates(root).find((t) => t.id === id);
  if (saved) return saved;
  throw new SsrRouteError(`unknown template id: ${id.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// File walking (jailed to root)
// ---------------------------------------------------------------------------

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (!SOURCE_EXTS.has(extname(e.name).toLowerCase())) continue;
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) {
          throw new SsrRouteError(`SSR_LIMITS: file over 200KB: ${relative(root, abs)}`);
        }
        out.push(abs);
      }
    }
  };
  walk(root);
  if (out.length >= MAX_FILES) {
    throw new SsrRouteError(`SSR_LIMITS: over ${MAX_FILES} scannable files`);
  }
  return out.sort();
}

function readInputs(root: string): Array<{ file: string; text: string }> {
  return collectFiles(root).map((abs) => ({
    file: relative(root, abs).split(sep).join('/'),
    text: readFileSync(abs, 'utf8'),
  }));
}

// ---------------------------------------------------------------------------
// Inspection checker: saved templates with asInspection → findings
// ---------------------------------------------------------------------------

/**
 * Checker provider for inspections.ts (registered via
 * setExtraCheckerProvider in index.ts). Each match of an
 * asInspection template becomes a finding; the finding `detail`
 * carries everything the desktop quick-fix button needs.
 */
export function ssrCheckerProvider(root: string): Checker[] {
  const templates = loadSavedTemplates(root).filter((t) => t.asInspection);
  if (templates.length === 0) return [];
  const checker: Checker = {
    name: 'ssr-template',
    description: 'Structural search templates saved as inspections (round-4 A4).',
    run({ file, lines }: { file: string; lines: string[] }) {
      const findings: Finding[] = [];
      if (!SOURCE_EXTS.has(extname(file).toLowerCase())) return findings;
      const text = lines.join('\n');
      for (const t of templates) {
        let matches: SsrMatch[];
        try {
          matches = findMatches([{ file, text }], t);
        } catch {
          continue;
        }
        for (const m of matches) {
          findings.push({
            id: `ssr-${t.id}-${file}-${m.startLine}`,
            checker: 'ssr-template',
            severity: t.severity ?? 'warning',
            file,
            line: m.startLine,
            message: `[ssr:${t.id}] ${m.kind} ${m.parent ? m.parent + '.' : ''}${m.name} matches template "${t.name}"`,
            detail: JSON.stringify({
              templateId: t.id,
              file,
              startLine: m.startLine,
              endLine: m.endLine,
              kind: m.kind,
              name: m.name,
            }),
          });
        }
      }
      return findings;
    },
  };
  return [checker];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function onlySelection(body: Record<string, unknown>): Array<{ file: string; startLine: number }> | undefined {
  if (body.only === undefined) return undefined;
  if (!Array.isArray(body.only)) throw new SsrRouteError('only must be an array of {file,startLine}');
  const out: Array<{ file: string; startLine: number }> = [];
  for (const o of body.only) {
    if (
      o === null ||
      typeof o !== 'object' ||
      typeof (o as Record<string, unknown>).file !== 'string' ||
      typeof (o as Record<string, unknown>).startLine !== 'number'
    ) {
      throw new SsrRouteError('only entries must be {file: string, startLine: number}');
    }
    out.push({ file: (o as Record<string, unknown>).file as string, startLine: (o as Record<string, unknown>).startLine as number });
  }
  return out;
}

export async function handleSsrRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const actor = 'human';

  try {
    // GET /api/ssr/templates
    if (method === 'GET' && path === `${PREFIX}/templates`) {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      ctx.json(res, 200, { builtins: builtinTemplates(), saved: loadSavedTemplates(root) });
      return true;
    }

    // POST /api/ssr/templates  { template }
    if (method === 'POST' && path === `${PREFIX}/templates`) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const { template, errors } = validateTemplate(body.template);
      if (!template || errors.length > 0) {
        ctx.json(res, 400, { error: `invalid template: ${errors.join('; ')}`.slice(0, 300) });
        return true;
      }
      if (builtinTemplateById(template.id)) {
        ctx.json(res, 409, { error: `id ${template.id} is reserved by a builtin template` });
        return true;
      }
      const saved = loadSavedTemplates(root).filter((t) => t.id !== template.id);
      saved.push(template);
      saveTemplates(root, saved);
      ctx.audit.record(actor, 'SSR_TEMPLATE_SAVED', 'ssr', root, { templateId: template.id });
      ctx.json(res, 200, { template });
      return true;
    }

    // DELETE /api/ssr/templates/:id
    const delMatch = /^\/api\/ssr\/templates\/([a-z0-9-]+)$/.exec(path);
    if (method === 'DELETE' && delMatch) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const before = loadSavedTemplates(root);
      const after = before.filter((t) => t.id !== delMatch[1]);
      if (after.length === before.length) {
        ctx.json(res, 404, { error: `unknown template id: ${delMatch[1]}` });
        return true;
      }
      saveTemplates(root, after);
      ctx.audit.record(actor, 'SSR_TEMPLATE_DELETED', 'ssr', root, { templateId: delMatch[1] });
      ctx.json(res, 200, { deleted: delMatch[1] });
      return true;
    }

    // POST /api/ssr/search  { root?, template }
    if (method === 'POST' && path === `${PREFIX}/search`) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const template = resolveTemplate(root, body.template);
      const matches = findMatches(readInputs(root), template);
      ctx.json(res, 200, {
        templateId: template.id,
        matches: matches.map((m) => ({
          file: m.file,
          kind: m.kind,
          name: m.name,
          parent: m.parent,
          startLine: m.startLine,
          endLine: m.endLine,
          modifiers: m.modifiers,
          snippet: m.snippet,
          templateId: m.templateId,
        })),
      });
      return true;
    }

    // POST /api/ssr/preview  { root?, template, only? }
    if (method === 'POST' && path === `${PREFIX}/preview`) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const template = resolveTemplate(root, body.template);
      if (!template.replace) {
        ctx.json(res, 400, { error: 'template has no replace spec (search-only template)' });
        return true;
      }
      const inputs = readInputs(root);
      const fileMap = new Map(inputs.map((f) => [f.file, f.text]));
      const matches = findMatches(inputs, template);
      const { diffs, skipped } = previewEdits(fileMap, matches, template, onlySelection(body));
      ctx.json(res, 200, {
        templateId: template.id,
        matchCount: matches.length,
        files: Object.entries(diffs).map(([file, diff]) => ({ file, diff })),
        skipped,
      });
      return true;
    }

    // POST /api/ssr/apply  { root?, template, only? }
    if (method === 'POST' && path === `${PREFIX}/apply`) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const template = resolveTemplate(root, body.template);
      if (!template.replace) {
        ctx.json(res, 400, { error: 'template has no replace spec (search-only template)' });
        return true;
      }
      const inputs = readInputs(root);
      const fileMap = new Map(inputs.map((f) => [f.file, f.text]));
      const matches = findMatches(inputs, template);
      const { edits, diffs, skipped } = previewEdits(fileMap, matches, template, onlySelection(body));
      const next = applyEdits(fileMap, edits);
      const filesChanged: string[] = [];
      for (const [file, text] of next) {
        if (text !== fileMap.get(file)) {
          writeFileSync(join(root, ...file.split('/')), text);
          filesChanged.push(file);
        }
      }
      ctx.audit.record(actor, 'SSR_TEMPLATE_APPLIED', 'ssr', root, {
        templateId: template.id,
        applied: edits.length,
        skipped: skipped.length,
        filesChanged,
      });
      ctx.json(res, 200, { templateId: template.id, applied: edits.length, skipped, filesChanged, diffs });
      return true;
    }

    // POST /api/ssr/quickfix  { root?, templateId, file, startLine }
    if (method === 'POST' && path === `${PREFIX}/quickfix`) {
      const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      const root = resolveRoot(typeof body.root === 'string' ? body.root : undefined);
      const templateId = typeof body.templateId === 'string' ? body.templateId : '';
      const file = typeof body.file === 'string' ? body.file : '';
      const startLine = typeof body.startLine === 'number' ? body.startLine : -1;
      if (!templateId || !file || startLine < 1 || file.includes('..')) {
        ctx.json(res, 400, { error: 'templateId, file and startLine are required' });
        return true;
      }
      const template = resolveTemplate(root, { id: templateId });
      if (!template.replace) {
        ctx.json(res, 400, { error: 'template has no replace spec (search-only template)' });
        return true;
      }
      const inputs = readInputs(root);
      const fileMap = new Map(inputs.map((f) => [f.file, f.text]));
      if (!fileMap.has(file)) {
        ctx.json(res, 404, { error: `file not found in root: ${file.slice(0, 120)}` });
        return true;
      }
      const matches = findMatches(inputs, template).filter((m) => m.file === file && m.startLine === startLine);
      if (matches.length === 0) {
        ctx.json(res, 409, { error: 'match no longer resolves (file changed since the finding was reported?)' });
        return true;
      }
      const { edits, diffs, skipped } = previewEdits(fileMap, matches, template);
      if (skipped.length > 0) {
        ctx.json(res, 409, { error: skipped[0].reason });
        return true;
      }
      const next = applyEdits(fileMap, edits);
      writeFileSync(join(root, ...file.split('/')), next.get(file)!);
      ctx.audit.record(actor, 'SSR_QUICKFIX_APPLIED', 'ssr', root, { templateId, file, startLine });
      ctx.json(res, 200, { applied: true, file, diff: diffs[file] ?? '' });
      return true;
    }
  } catch (e) {
    if (e instanceof SsrRouteError) {
      ctx.json(res, 400, { error: e.message.slice(0, 300) });
      return true;
    }
    throw e;
  }

  return false;
}
