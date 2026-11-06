/**
 * Deterministic recipe-based code migration (Amazon Q Developer
 * `/transform` / OpenRewrite style), zero-model.
 *
 * A recipe is a declarative JSON document describing a mechanical,
 * reviewable migration: a set of deterministic file transforms
 * (literal replace, regex replace, JSON path patch, anchored insert,
 * file creation) plus optional verify commands. The workflow is:
 *
 *   select recipe → generate PLAN (per-file diff preview, nothing is
 *   written) → plan goes through the central approval system
 *   (/api/approvals, action `recipes.apply:<runId>`) → execute applies
 *   the planned file contents verbatim → verify commands (build/test)
 *   run through the same exit-code-only shell runner posture as the
 *   quality gate → every step is audited (RECIPE_*).
 *
 * WHAT THIS IS, honestly (also stated in the desktop UI copy):
 *
 *  - DETERMINISTIC ONLY. There is no generative fallback: a recipe does
 *    exactly what its JSON says, byte for byte. Anything a recipe does
 *    not cover (an op that finds no match, a file the preconditions
 *    exclude, leftover old-world markers found by the post-scan) is
 *    reported in an explicit UNHANDLED list — never silently skipped.
 *  - NOT semantic refactoring. `replace` is a literal string swap,
 *    `regex-replace` is a blind pattern swap, `json-patch` edits one
 *    JSON value at a dot path. None of them understand your code.
 *  - The plan is a snapshot: execution re-checks every target file's
 *    sha256 against the plan and REFUSES (fail-closed, RECIPE_DRIFT)
 *    when the file changed since planning. Re-plan instead.
 *  - Verify commands run with the operator's own privileges (same
 *    trust posture as quality-gate commands and batch `run:` steps):
 *    they come from the recipe JSON the operator selected, the
 *    judgment is exit-code-only, output is truncated at 20KB/stream
 *    (disclosed), and there is NO sandbox claim.
 *  - Path jail: the target project directory must sit under
 *    FACTORY_RECIPE_ROOTS (comma-separated); empty = deny everything,
 *    fail-closed. Every file path inside a recipe is relative and
 *    jailed to the project directory; symlinks are not followed.
 *
 * Persistence: AI_FACTORY_DATA_DIR/recipes.json (run records), atomic
 * temp+rename writes, fail-closed on corrupt file. Custom recipes:
 * AI_FACTORY_DATA_DIR/recipes-custom.json (same fail-closed posture).
 * Builtin recipes ship as JSON files in src/recipes/builtin/ (copied
 * into dist/recipes/builtin by the server build script).
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactText } from '@ai-factory/diagpack';
import { scrubCredentialEnv } from '@ai-factory/runtime';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class RecipeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecipeError';
    this.code = code;
  }
}

export function recipeErrorStatus(e: unknown): number {
  if (e instanceof RecipeError) {
    switch (e.code) {
      case 'RECIPE_NOT_FOUND':
      case 'RUN_NOT_FOUND':
        return 404;
      case 'RECIPE_INVALID':
      case 'BAD_REQUEST':
      case 'PATH_ESCAPE':
        return 400;
      case 'APPROVAL_REQUIRED':
      case 'APPROVAL_NOT_APPROVED':
      case 'APPROVAL_MISMATCH':
        return 403;
      case 'RECIPE_CONFLICT':
      case 'RUN_NOT_PLANNED':
      case 'RECIPE_DRIFT':
        return 409;
      case 'STORE_CORRUPT':
        return 503;
      default:
        return 500;
    }
  }
  return 500;
}

/* ------------------------------------------------------------------ */
/* Recipe spec: types + strict JSON validation                          */
/* ------------------------------------------------------------------ */

export type TransformOp =
  | {
      op: 'replace';
      file: string;
      search: string;
      replace: string;
      occurrences?: number | 'all';
      mustMatch?: boolean;
    }
  | {
      op: 'regex-replace';
      file: string;
      pattern: string;
      flags?: string;
      replace: string;
      mustMatch?: boolean;
    }
  | { op: 'json-patch'; file: string; path: string; value?: unknown; remove?: boolean }
  | {
      op: 'insert';
      file: string;
      anchor: string;
      position: 'before' | 'after';
      text: string;
      mustMatch?: boolean;
    }
  | { op: 'create-file'; file: string; content: string; ifExists?: 'fail' | 'skip' };

export interface RecipeMatch {
  /** Files (relative to project root) the recipe primarily targets. */
  files: string[];
  /**
   * Precondition strings: at least one must appear in the union of the
   * match.files contents, otherwise the recipe is "not applicable" to
   * this project and the plan says so (nothing is applied).
   */
  contains?: string[];
  /**
   * "Old world" marker strings. The plan scans project files matching
   * scanGlobs for these; any file still containing a marker that the
   * recipe does NOT rewrite lands in the unhandled list.
   */
  scanFor?: string[];
  scanGlobs?: string[];
  /**
   * Legacy FILENAME globs (e.g. ".eslintrc", ".eslintrc.*"). Files
   * matching these names that the recipe does NOT rewrite land in the
   * unhandled list — content markers cannot express "the legacy file
   * itself".
   */
  scanFilenames?: string[];
}

export interface RecipeSpec {
  name: string;
  version: string;
  description: string;
  tags: string[];
  match: RecipeMatch;
  transform: TransformOp[];
  verify?: { build?: string; test?: string };
  /** Honest-boundary note shown in the UI next to the recipe. */
  notes?: string;
  source: 'builtin' | 'custom';
}

const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_RECIPE_BYTES = 200_000;
const MAX_FILE_BYTES = 2_000_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new RecipeError('RECIPE_INVALID', `${what} must be a non-empty string`);
  }
  return v.trim();
}

function jailedRelPath(v: unknown, what: string): string {
  const s = asString(v, what);
  if (isAbsolute(s) || s.split('/').includes('..') || s.includes('\\')) {
    throw new RecipeError('RECIPE_INVALID', `${what} must be a relative POSIX path without "..": ${s}`);
  }
  return s;
}

function optMustMatch(raw: Record<string, unknown>, what: string): boolean | undefined {
  const mm = raw['mustMatch'];
  if (mm === undefined || mm === null) return undefined;
  if (typeof mm !== 'boolean') throw new RecipeError('RECIPE_INVALID', `${what}: mustMatch must be true/false`);
  return mm;
}

function validateOp(raw: unknown, idx: number): TransformOp {
  if (!isPlainObject(raw)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}] must be an object`);
  const kind = raw['op'];
  const file = jailedRelPath(raw['file'], `transform[${idx}].file`);
  if (kind === 'replace') {
    const allowed = new Set(['op', 'file', 'search', 'replace', 'occurrences', 'mustMatch']);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown key "${k}"`);
    const search = typeof raw['search'] === 'string' ? raw['search'] : '';
    if (!search) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: search must be non-empty`);
    const replace = typeof raw['replace'] === 'string' ? raw['replace'] : '';
    let occurrences: number | 'all' | undefined;
    const occ = raw['occurrences'];
    if (occ !== undefined && occ !== null) {
      if (occ === 'all') occurrences = 'all';
      else if (typeof occ === 'number' && Number.isInteger(occ) && occ >= 1) occurrences = occ;
      else throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: occurrences must be a positive integer or "all"`);
    }
    const mustMatch = optMustMatch(raw, `transform[${idx}]`);
    return { op: 'replace', file, search, replace, ...(occurrences !== undefined ? { occurrences } : {}), ...(mustMatch !== undefined ? { mustMatch } : {}) };
  }
  if (kind === 'regex-replace') {
    const allowed = new Set(['op', 'file', 'pattern', 'flags', 'replace', 'mustMatch']);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown key "${k}"`);
    const pattern = typeof raw['pattern'] === 'string' ? raw['pattern'] : '';
    if (!pattern) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: pattern must be non-empty`);
    const flags = raw['flags'] === undefined || raw['flags'] === null ? undefined : asString(raw['flags'], `transform[${idx}].flags`);
    if (flags !== undefined && !/^[gims]*$/.test(flags)) {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: flags may only contain g/i/m/s`);
    }
    try {
      new RegExp(pattern, flags ?? '');
    } catch (e) {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: invalid regex: ${(e as Error).message}`);
    }
    const replace = typeof raw['replace'] === 'string' ? raw['replace'] : '';
    const mustMatch = optMustMatch(raw, `transform[${idx}]`);
    return { op: 'regex-replace', file, pattern, ...(flags !== undefined ? { flags } : {}), replace, ...(mustMatch !== undefined ? { mustMatch } : {}) };
  }
  if (kind === 'json-patch') {
    const allowed = new Set(['op', 'file', 'path', 'value', 'remove']);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown key "${k}"`);
    const path = asString(raw['path'], `transform[${idx}].path`);
    if (path.split('.').some((seg) => !seg)) {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: path segments must be non-empty (dot path)`);
    }
    if (path === '__proto__' || path.split('.').includes('__proto__') || path.split('.').includes('constructor') || path.split('.').includes('prototype')) {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: path may not touch prototype keys`);
    }
    const remove = raw['remove'] === true;
    if (!remove && !('value' in raw)) {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: json-patch requires "value" or "remove": true`);
    }
    return { op: 'json-patch', file, path, ...(remove ? { remove: true } : { value: raw['value'] }) };
  }
  if (kind === 'insert') {
    const allowed = new Set(['op', 'file', 'anchor', 'position', 'text', 'mustMatch']);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown key "${k}"`);
    const anchor = typeof raw['anchor'] === 'string' ? raw['anchor'] : '';
    if (!anchor) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: anchor must be non-empty`);
    const position = raw['position'];
    if (position !== 'before' && position !== 'after') {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: position must be "before" or "after"`);
    }
    const text = typeof raw['text'] === 'string' ? raw['text'] : '';
    const mustMatch = optMustMatch(raw, `transform[${idx}]`);
    return { op: 'insert', file, anchor, position, text, ...(mustMatch !== undefined ? { mustMatch } : {}) };
  }
  if (kind === 'create-file') {
    const allowed = new Set(['op', 'file', 'content', 'ifExists']);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown key "${k}"`);
    const content = typeof raw['content'] === 'string' ? raw['content'] : '';
    if (content.length > 100_000) throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: create-file content too large (max 100KB)`);
    const ifExists = raw['ifExists'] === undefined || raw['ifExists'] === null ? undefined : raw['ifExists'];
    if (ifExists !== undefined && ifExists !== 'fail' && ifExists !== 'skip') {
      throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: ifExists must be "fail" or "skip"`);
    }
    return { op: 'create-file', file, content, ...(ifExists !== undefined ? { ifExists } : {}) };
  }
  throw new RecipeError('RECIPE_INVALID', `transform[${idx}]: unknown op "${String(kind)}" (expected replace | regex-replace | json-patch | insert | create-file)`);
}

/** Strict validation of an unknown value into a RecipeSpec. */
export function validateRecipe(raw: unknown, source: 'builtin' | 'custom'): RecipeSpec {
  if (!isPlainObject(raw)) throw new RecipeError('RECIPE_INVALID', 'recipe must be a JSON object');
  const allowed = new Set(['name', 'version', 'description', 'tags', 'match', 'transform', 'verify', 'notes']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new RecipeError('RECIPE_INVALID', `unknown recipe key "${k}"`);
  }
  const name = asString(raw['name'], 'recipe.name');
  if (!RECIPE_NAME_RE.test(name)) {
    throw new RecipeError('RECIPE_INVALID', `recipe.name "${name}" must be lowercase kebab-case (2..64 chars)`);
  }
  const version = asString(raw['version'] ?? '1.0.0', 'recipe.version').slice(0, 32);
  const description = asString(raw['description'], 'recipe.description').slice(0, 500);
  const tagsRaw = raw['tags'] ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.some((t) => typeof t !== 'string')) {
    throw new RecipeError('RECIPE_INVALID', 'recipe.tags must be a list of strings');
  }
  const tags = tagsRaw.map((t) => (t as string).slice(0, 32)).slice(0, 10);

  if (!isPlainObject(raw['match'])) throw new RecipeError('RECIPE_INVALID', 'recipe.match is required');
  const m = raw['match'];
  const mAllowed = new Set(['files', 'contains', 'scanFor', 'scanGlobs', 'scanFilenames']);
  for (const k of Object.keys(m)) if (!mAllowed.has(k)) throw new RecipeError('RECIPE_INVALID', `recipe.match: unknown key "${k}"`);
  if (!Array.isArray(m['files']) || m['files'].length === 0) {
    throw new RecipeError('RECIPE_INVALID', 'recipe.match.files must be a non-empty list');
  }
  const files = m['files'].map((f, i) => jailedRelPath(f, `recipe.match.files[${i}]`));
  const strList = (v: unknown, what: string, max: number): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(x as string).trim())) {
      throw new RecipeError('RECIPE_INVALID', `${what} must be a list of non-empty strings`);
    }
    return (v as string[]).map((s) => s.slice(0, 200)).slice(0, max);
  };
  const contains = strList(m['contains'], 'recipe.match.contains', 10);
  const scanFor = strList(m['scanFor'], 'recipe.match.scanFor', 10);
  const scanGlobsRaw = strList(m['scanGlobs'], 'recipe.match.scanGlobs', 10);
  const scanGlobs = scanGlobsRaw?.map((g, i) => jailedRelPath(g, `recipe.match.scanGlobs[${i}]`));
  const scanFilenamesRaw = strList(m['scanFilenames'], 'recipe.match.scanFilenames', 10);
  const scanFilenames = scanFilenamesRaw?.map((g, i) => jailedRelPath(g, `recipe.match.scanFilenames[${i}]`));

  if (!Array.isArray(raw['transform']) || raw['transform'].length === 0) {
    throw new RecipeError('RECIPE_INVALID', 'recipe.transform must be a non-empty list');
  }
  if (raw['transform'].length > 50) throw new RecipeError('RECIPE_INVALID', 'recipe.transform: at most 50 ops');
  const transform = raw['transform'].map((o, i) => validateOp(o, i));

  let verify: RecipeSpec['verify'];
  if (raw['verify'] !== undefined && raw['verify'] !== null) {
    if (!isPlainObject(raw['verify'])) throw new RecipeError('RECIPE_INVALID', 'recipe.verify must be an object');
    const v = raw['verify'];
    const vAllowed = new Set(['build', 'test']);
    for (const k of Object.keys(v)) if (!vAllowed.has(k)) throw new RecipeError('RECIPE_INVALID', `recipe.verify: unknown key "${k}"`);
    const build = v['build'] === undefined ? undefined : asString(v['build'], 'recipe.verify.build');
    const test = v['test'] === undefined ? undefined : asString(v['test'], 'recipe.verify.test');
    for (const [label, cmd] of [['build', build], ['test', test]] as const) {
      if (cmd && cmd.length > 2000) throw new RecipeError('RECIPE_INVALID', `recipe.verify.${label} too long (max 2000)`);
    }
    verify = { ...(build ? { build } : {}), ...(test ? { test } : {}) };
  }
  const notes = raw['notes'] === undefined ? undefined : asString(raw['notes'], 'recipe.notes').slice(0, 1000);
  return {
    name,
    version,
    description,
    tags,
    match: { files, ...(contains ? { contains } : {}), ...(scanFor ? { scanFor } : {}), ...(scanGlobs ? { scanGlobs } : {}), ...(scanFilenames ? { scanFilenames } : {}) },
    transform,
    ...(verify ? { verify } : {}),
    ...(notes ? { notes } : {}),
    source,
  };
}

/** Parse a recipe from raw JSON text (used for custom recipes + builtins). */
export function parseRecipeJson(text: string, source: 'builtin' | 'custom'): RecipeSpec {
  if (typeof text !== 'string' || !text.trim()) throw new RecipeError('RECIPE_INVALID', 'recipe JSON is empty');
  if (text.length > MAX_RECIPE_BYTES) throw new RecipeError('RECIPE_INVALID', 'recipe JSON too large (max 200KB)');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RecipeError('RECIPE_INVALID', `recipe JSON parse error: ${(e as Error).message}`);
  }
  return validateRecipe(raw, source);
}


/* ------------------------------------------------------------------ */
/* Builtin recipe library (JSON files in <module>/recipes/builtin)      */
/* ------------------------------------------------------------------ */

/**
 * Locate the builtin recipe directory without import.meta / __dirname
 * (both break one of the dual modes: tsc compiles server src as
 * CommonJS, node type-stripping loads it as ESM):
 *
 *  1. AI_FACTORY_RECIPES_BUILTIN_DIR (explicit override; tests use this)
 *  2. sibling of the running server entry (process.argv[1] = dist/index.js
 *     in production / packaged runs → dist/recipes/builtin)
 *  3. repo-root cwd layouts: apps/server/src/recipes/builtin,
 *     apps/server/dist/recipes/builtin
 */
export function builtinRecipesDir(): string | null {
  const candidates: string[] = [];
  const envDir = process.env.AI_FACTORY_RECIPES_BUILTIN_DIR;
  if (envDir && envDir.trim()) candidates.push(resolve(envDir.trim()));
  const argv1 = process.argv[1];
  if (argv1) {
    const entryDir = dirname(resolve(argv1));
    candidates.push(join(entryDir, 'recipes', 'builtin'));
  }
  const cwd = process.cwd();
  candidates.push(join(cwd, 'apps', 'server', 'src', 'recipes', 'builtin'));
  candidates.push(join(cwd, 'apps', 'server', 'dist', 'recipes', 'builtin'));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function loadBuiltinRecipes(): RecipeSpec[] {
  const dir = builtinRecipesDir();
  if (!dir) return [];
  const out: RecipeSpec[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const text = readFileSync(join(dir, entry), 'utf8');
    out.push(parseRecipeJson(text, 'builtin'));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Path jail                                                            */
/* ------------------------------------------------------------------ */

export function recipeRootsFromEnv(): string[] {
  const raw = process.env.FACTORY_RECIPE_ROOTS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
}

function assertInsideRoots(abs: string, roots: string[]): void {
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return;
  }
  throw new RecipeError(
    'PATH_ESCAPE',
    `project path is outside the allowed roots (set FACTORY_RECIPE_ROOTS): ${abs}`,
  );
}

/** Resolve + jail a target project directory. Fail-closed. */
export function resolveProjectDir(projectPath: string): string {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new RecipeError('BAD_REQUEST', 'projectPath is required');
  }
  const abs = resolve(projectPath.trim());
  assertInsideRoots(abs, recipeRootsFromEnv());
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new RecipeError('BAD_REQUEST', `project path does not exist: ${abs}`);
  }
  const st = lstatSync(real);
  if (!st.isDirectory()) throw new RecipeError('BAD_REQUEST', `project path is not a directory: ${real}`);
  return real;
}

/** Resolve a recipe-relative file path inside the project dir (jailed). */
function jailedFile(projectDir: string, rel: string): string {
  const abs = resolve(projectDir, rel);
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) {
    throw new RecipeError('PATH_ESCAPE', `file path escapes the project directory: ${rel}`);
  }
  return abs;
}

function readProjectFile(projectDir: string, rel: string): string | null {
  const abs = jailedFile(projectDir, rel);
  if (!existsSync(abs)) return null;
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new RecipeError('PATH_ESCAPE', `refusing to follow symlink: ${rel}`);
  }
  if (!st.isFile()) throw new RecipeError('BAD_REQUEST', `not a regular file: ${rel}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new RecipeError('BAD_REQUEST', `file too large for recipe transforms (max 2MB): ${rel}`);
  }
  return readFileSync(abs, 'utf8');
}

/* ------------------------------------------------------------------ */
/* Minimal glob matcher for scanGlobs (* within a segment, ** any)      */
/* ------------------------------------------------------------------ */

export function matchGlob(pattern: string, relPath: string): boolean {
  const pSegs = pattern.split('/');
  const fSegs = relPath.split('/');
  return matchSegs(pSegs, 0, fSegs, 0);
}

function matchSegs(p: string[], pi: number, f: string[], fi: number): boolean {
  if (pi === p.length) return fi === f.length;
  if (p[pi] === '**') {
    for (let k = fi; k <= f.length; k++) {
      if (matchSegs(p, pi + 1, f, k)) return true;
    }
    return false;
  }
  if (fi >= f.length) return false;
  const re = new RegExp('^' + p[pi].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  if (!re.test(f[fi])) return false;
  return matchSegs(p, pi + 1, f, fi + 1);
}

/* ------------------------------------------------------------------ */
/* Bounded unified-ish line diff for plan previews                      */
/* ------------------------------------------------------------------ */

const MAX_DIFF_LINES = 240;
const MAX_DIFF_INPUT_LINES = 5000;

/**
 * Line-based diff with 1 line of context. Deliberately small: LCS over
 * lines, capped. When the input is too large the preview says so
 * instead of burning CPU — the plan still carries the exact planned
 * content hash, which is what execution actually applies.
 */
export function diffPreview(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_INPUT_LINES || b.length > MAX_DIFF_INPUT_LINES) {
    return `(diff preview skipped: file has ${Math.max(a.length, b.length)} lines; planned content is applied verbatim from the plan snapshot)`;
  }
  // LCS table (bounded by the line caps above).
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Row = { tag: ' ' | '-' | '+'; text: string };
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ tag: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ tag: '-', text: a[i] });
      i++;
    } else {
      rows.push({ tag: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ tag: '-', text: a[i++] });
  while (j < m) rows.push({ tag: '+', text: b[j++] });
  // Keep changed rows plus 1 context line around them; collapse the rest.
  const keep = new Set<number>();
  rows.forEach((r, idx) => {
    if (r.tag !== ' ') {
      keep.add(idx);
      if (idx > 0) keep.add(idx - 1);
      if (idx < rows.length - 1) keep.add(idx + 1);
    }
  });
  const out: string[] = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (keep.has(idx)) {
      if (skipped > 0) {
        out.push(`  … (${skipped} unchanged lines)`);
        skipped = 0;
      }
      out.push(`${r.tag} ${r.text}`);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push(`  … (${skipped} unchanged lines)`);
  if (out.length > MAX_DIFF_LINES) {
    const head = out.slice(0, MAX_DIFF_LINES);
    head.push(`… (diff preview truncated at ${MAX_DIFF_LINES} lines)`);
    return head.join('\n');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Transform application (on in-memory content)                         */
/* ------------------------------------------------------------------ */

export interface OpOutcome {
  opIndex: number;
  op: string;
  file: string;
  status: 'applied' | 'no-match' | 'error';
  note: string;
}

function applyReplace(content: string, op: Extract<TransformOp, { op: 'replace' }>): { content: string; outcome: Omit<OpOutcome, 'opIndex' | 'op' | 'file'> } {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(op.search, idx)) !== -1) {
    count++;
    idx += op.search.length;
  }
  const mustMatch = op.mustMatch !== false;
  if (count === 0) {
    return {
      content,
      outcome: mustMatch
        ? { status: 'error', note: `no match for search string in ${op.file} (mustMatch)` }
        : { status: 'no-match', note: `no match in ${op.file} (mustMatch:false — left unchanged, listed as unhandled)` },
    };
  }
  const want = op.occurrences ?? 1;
  let replaced = 0;
  let out: string;
  if (want === 'all') {
    out = content.split(op.search).join(op.replace);
    replaced = count;
  } else {
    let rest = content;
    const parts: string[] = [];
    for (let k = 0; k < want && rest.includes(op.search); k++) {
      const at = rest.indexOf(op.search);
      parts.push(rest.slice(0, at), op.replace);
      rest = rest.slice(at + op.search.length);
      replaced++;
    }
    parts.push(rest);
    out = parts.join('');
    if (mustMatch && replaced < want) {
      return { content, outcome: { status: 'error', note: `only ${replaced} of ${want} occurrences matched in ${op.file}` } };
    }
  }
  return { content: out, outcome: { status: 'applied', note: `replaced ${replaced} of ${count} occurrence(s) in ${op.file}` } };
}

function applyRegex(content: string, op: Extract<TransformOp, { op: 'regex-replace' }>): { content: string; outcome: Omit<OpOutcome, 'opIndex' | 'op' | 'file'> } {
  const mustMatch = op.mustMatch !== false;
  const flags = op.flags ?? '';
  const globalRe = new RegExp(op.pattern, flags.includes('g') ? flags : flags + 'g');
  const matches = content.match(globalRe);
  const count = matches ? matches.length : 0;
  if (count === 0) {
    return {
      content,
      outcome: mustMatch
        ? { status: 'error', note: `regex matched nothing in ${op.file} (mustMatch)` }
        : { status: 'no-match', note: `regex matched nothing in ${op.file} (mustMatch:false — listed as unhandled)` },
    };
  }
  const applyRe = new RegExp(op.pattern, flags);
  const out = content.replace(applyRe, op.replace);
  if (out === content) {
    return { content, outcome: { status: 'error', note: `regex matched ${count} time(s) in ${op.file} but produced no change` } };
  }
  return { content: out, outcome: { status: 'applied', note: `regex replaced ${count} match(es) in ${op.file}` } };
}

/** Deterministic JSON dot-path patch. Objects: missing keys are created;
 *  arrays: index must exist (no sparse growth — that would be a guess). */
export function applyJsonPatch(content: string, op: Extract<TransformOp, { op: 'json-patch' }>): { content: string; outcome: Omit<OpOutcome, 'opIndex' | 'op' | 'file'> } {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    return { content, outcome: { status: 'error', note: `${op.file} is not valid JSON: ${(e as Error).message}` } };
  }
  const segs = op.path.split('.');
  let parent: unknown = doc;
  for (let s = 0; s < segs.length - 1; s++) {
    const seg = segs[s];
    if (Array.isArray(parent)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        return { content, outcome: { status: 'error', note: `json-patch: array index ${seg} out of range at "${segs.slice(0, s + 1).join('.')}" in ${op.file}` } };
      }
      parent = parent[idx];
    } else if (isPlainObject(parent)) {
      if (!(seg in parent)) parent[seg] = {};
      parent = parent[seg];
    } else {
      return { content, outcome: { status: 'error', note: `json-patch: cannot descend into "${seg}" (not an object/array) in ${op.file}` } };
    }
  }
  const last = segs[segs.length - 1];
  const hadKey = isPlainObject(parent)
    ? last in parent
    : Array.isArray(parent) && Number.isInteger(Number(last)) && Number(last) >= 0 && Number(last) < parent.length;
  if (op.remove === true) {
    if (!hadKey) {
      return { content, outcome: { status: 'no-match', note: `json-patch: "${op.path}" not present in ${op.file} — nothing to remove (listed as unhandled)` } };
    }
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete (parent as Record<string, unknown>)[last];
    return { content: serializeJson(doc, content), outcome: { status: 'applied', note: `json-patch: removed "${op.path}" from ${op.file}` } };
  }
  if (Array.isArray(parent)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
      return { content, outcome: { status: 'error', note: `json-patch: array index ${last} out of range in ${op.file}` } };
    }
    parent[idx] = op.value;
  } else if (isPlainObject(parent)) {
    parent[last] = op.value;
  } else {
    return { content, outcome: { status: 'error', note: `json-patch: "${op.path}" parent is not an object/array in ${op.file}` } };
  }
  return { content: serializeJson(doc, content), outcome: { status: 'applied', note: `json-patch: set "${op.path}" in ${op.file}${hadKey ? '' : ' (new key)'}` } };
}

/** Preserve the file's indent style (2 spaces default; tab if detected). */
function serializeJson(doc: unknown, original: string): string {
  const indent = original.includes('\n\t') ? '\t' : 2;
  const trailing = original.endsWith('\n') ? '\n' : '';
  return JSON.stringify(doc, null, indent) + trailing;
}

function applyInsert(content: string, op: Extract<TransformOp, { op: 'insert' }>): { content: string; outcome: Omit<OpOutcome, 'opIndex' | 'op' | 'file'> } {
  const mustMatch = op.mustMatch !== false;
  const at = content.indexOf(op.anchor);
  if (at === -1) {
    return {
      content,
      outcome: mustMatch
        ? { status: 'error', note: `anchor not found in ${op.file} (mustMatch)` }
        : { status: 'no-match', note: `anchor not found in ${op.file} (mustMatch:false — listed as unhandled)` },
    };
  }
  const cut = op.position === 'before' ? at : at + op.anchor.length;
  const out = content.slice(0, cut) + op.text + content.slice(cut);
  return { content: out, outcome: { status: 'applied', note: `inserted ${op.position} anchor in ${op.file}` } };
}


/* ------------------------------------------------------------------ */
/* Plan: pure (no writes)                                               */
/* ------------------------------------------------------------------ */

export interface PlannedOpDetail extends OpOutcome {
  opIndex: number;
  /** Line-diff preview for this op (may be null when the op is skipped). */
  diff: string | null;
}

export interface PlannedFile {
  file: string;
  /** sha256 of the file content at plan time (execution re-verifies). */
  beforeSha256: string;
  existsBefore: boolean;
  /** Full planned new content (null when the file is not created). */
  afterContent: string | null;
  /** null when the file will not change. */
  diff: string | null;
  ops: PlannedOpDetail[];
  /** True when at least one op applied and content differs. */
  willChange: boolean;
}

export interface UnhandledItem {
  /** File (relative) the item belongs to, if any. */
  file?: string;
  opIndex?: number;
  reason: string;
}

export interface RecipePlan {
  recipeName: string;
  recipeVersion: string;
  projectPath: string;
  applicable: boolean;
  /** Why not applicable / planning warnings. */
  notes: string[];
  files: PlannedFile[];
  unhandled: UnhandledItem[];
  /** Ops that applied cleanly. */
  appliedOps: number;
  /** Ops that did not apply (mustMatch:false or create skipped). */
  noMatchOps: number;
  /** Ops that errored. */
  errorOps: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Skip build/dependency noise while scanning for leftover markers. */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.ai-factory', 'target', 'vendor']);
const MAX_SCAN_FILES = 2000;
const MAX_SCAN_FILE_BYTES = 512_000;
const MAX_SCAN_DEPTH = 6;

function collectScanFiles(projectDir: string, globs: string[] | undefined): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= MAX_SCAN_FILES || depth > MAX_SCAN_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (found.length >= MAX_SCAN_FILES) return;
      const abs = join(dir, e);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow symlinks
      const rel = relative(projectDir, abs).split(sep).join('/');
      if (st.isDirectory()) {
        const base = e;
        if (SCAN_SKIP_DIRS.has(base) || base.startsWith('.')) continue;
        visit(abs, depth + 1);
      } else if (st.isFile()) {
        if (st.size > MAX_SCAN_FILE_BYTES) continue;
        if (!globs || globs.length === 0 || globs.some((g) => matchGlob(g, rel))) {
          found.push(rel);
        }
      }
    }
  };
  visit(projectDir, 0);
  return found;
}

export function computePlan(recipe: RecipeSpec, projectPath: string): RecipePlan {
  const projectDir = resolveProjectDir(projectPath);
  const notes: string[] = [];
  const unhandled: UnhandledItem[] = [];
  const plannedByFile = new Map<string, PlannedFile>();
  const fileContent = new Map<string, { exists: boolean; before: string }>();

  // Load every file touched by any op (missing files are errors at
  // execution; at plan time they are unhandled, not fatal — EXCEPT
  // create-file, whose semantics are about absence).
  const touchFiles = new Set<string>();
  for (const op of recipe.transform) touchFiles.add(op.file);
  for (const f of recipe.match.files) touchFiles.add(f);
  for (const rel of touchFiles) {
    try {
      const content = readProjectFile(projectDir, rel);
      fileContent.set(rel, { exists: content !== null, before: content ?? '' });
    } catch (e) {
      unhandled.push({ file: rel, reason: `plan could not read file: ${(e as Error).message}` });
      fileContent.set(rel, { exists: false, before: '' });
    }
  }

  // Preconditions: at least one `contains` marker in the union of
  // match.files, else the recipe does not apply to this project.
  let applicable = true;
  if (recipe.match.contains && recipe.match.contains.length > 0) {
    const union = recipe.match.files
      .map((f) => fileContent.get(f))
      .filter((x): x is { exists: boolean; before: string } => !!x && x.exists)
      .map((x) => x.before)
      .join('\n');
    const hit = recipe.match.contains.some((m) => union.includes(m));
    if (!hit) {
      applicable = false;
      notes.push(
        `preconditions not met: none of [${recipe.match.contains.join(', ')}] found in ${recipe.match.files.join(', ')} — the recipe does not apply to this project`,
      );
      unhandled.push({ reason: `recipe not applicable to this project (precondition markers absent)` });
    }
  }

  let appliedOps = 0;
  let noMatchOps = 0;
  let errorOps = 0;

  recipe.transform.forEach((op, opIndex) => {
    const base = { opIndex, op: op.op, file: op.file };
    if (!applicable) {
      unhandled.push({ file: op.file, opIndex, reason: 'recipe not applicable to this project — op not evaluated' });
      return;
    }
    if (op.op === 'create-file') {
      const cur = fileContent.get(op.file);
      if (cur && cur.exists) {
        const ifExists = op.ifExists ?? 'fail';
        if (ifExists === 'fail') {
          errorOps++;
          const opOut: OpOutcome = { ...base, status: 'error', note: `${op.file} already exists (create-file, ifExists: fail)` };
          addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: null });
        } else {
          noMatchOps++;
          unhandled.push({ file: op.file, opIndex, reason: `${op.file} already exists — create skipped (ifExists: skip)` });
          const opOut: OpOutcome = { ...base, status: 'no-match', note: 'file exists, skipped' };
          addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: null });
        }
        return;
      }
      appliedOps++;
      const prev = plannedByFile.get(op.file)?.afterContent ?? '';
      const afterContent = prev + op.content;
      const opOut: OpOutcome = { ...base, status: 'applied', note: `created ${op.file} (${op.content.length} bytes)` };
      addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: diffPreview(prev, afterContent) }, afterContent);
      return;
    }
    const cur = fileContent.get(op.file);
    if (!cur || !cur.exists) {
      errorOps++;
      const opOut: OpOutcome = { ...base, status: 'error', note: `${op.file} does not exist in the project` };
      unhandled.push({ file: op.file, opIndex, reason: `${op.file} does not exist — op could not be applied` });
      addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: null });
      return;
    }
    const pf = plannedByFile.get(op.file);
    const prevContent = pf?.afterContent ?? cur.before;
    const beforeOp = prevContent;
    let res: { content: string; outcome: Omit<OpOutcome, 'opIndex' | 'op' | 'file'> };
    switch (op.op) {
      case 'replace':
        res = applyReplace(beforeOp, op);
        break;
      case 'regex-replace':
        res = applyRegex(beforeOp, op);
        break;
      case 'json-patch':
        res = applyJsonPatch(beforeOp, op);
        break;
      case 'insert':
        res = applyInsert(beforeOp, op);
        break;
    }
    const opOut: OpOutcome = { ...base, ...res.outcome };
    if (res.outcome.status === 'applied') {
      appliedOps++;
      const diff = res.content === beforeOp ? null : diffPreview(beforeOp, res.content);
      addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff }, res.content);
    } else if (res.outcome.status === 'no-match') {
      noMatchOps++;
      unhandled.push({ file: op.file, opIndex, reason: res.outcome.note });
      addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: null });
    } else {
      errorOps++;
      unhandled.push({ file: op.file, opIndex, reason: res.outcome.note });
      addPlannedOp(plannedByFile, fileContent, op.file, { ...opOut, diff: null });
    }
  });

  // Post-scan: old-world markers in files the recipe never rewrote.
  // Honest promise: nothing the recipe claims to retire may linger
  // silently in files it did not touch. Plus legacy filenames
  // (scanFilenames): the leftover file itself, not its contents.
  if (applicable) {
    const rewritten = new Set(
      [...plannedByFile.values()].filter((p) => p.willChange).map((p) => p.file),
    );
    if (recipe.match.scanFor && recipe.match.scanFor.length > 0) {
      const scanned = collectScanFiles(projectDir, recipe.match.scanGlobs);
      for (const rel of scanned) {
        if (rewritten.has(rel)) continue;
        let content: string;
        try {
          content = readFileSync(join(projectDir, rel), 'utf8');
        } catch {
          continue;
        }
        const hit = recipe.match.scanFor.find((m) => content.includes(m));
        if (hit) {
          unhandled.push({ file: rel, reason: `contains old-world marker "${hit}" but the recipe does not rewrite this file — needs manual handling` });
        }
      }
    }
    if (recipe.match.scanFilenames && recipe.match.scanFilenames.length > 0) {
      const scanned = collectScanFiles(projectDir, undefined);
      for (const rel of scanned) {
        if (rewritten.has(rel)) continue;
        if (recipe.match.scanFilenames.some((g) => matchGlob(g, rel))) {
          unhandled.push({ file: rel, reason: `matches legacy filename pattern "${rel}" but the recipe does not migrate it — needs manual handling` });
        }
      }
    }
  }

  const files: PlannedFile[] = [...plannedByFile.values()];
  return {
    recipeName: recipe.name,
    recipeVersion: recipe.version,
    projectPath: projectDir,
    applicable,
    notes,
    files,
    unhandled,
    appliedOps,
    noMatchOps,
    errorOps,
  };
}

function addPlannedOp(
  plannedByFile: Map<string, PlannedFile>,
  fileContent: Map<string, { exists: boolean; before: string }>,
  rel: string,
  op: PlannedOpDetail,
  newContent?: string,
): void {
  let pf = plannedByFile.get(rel);
  if (!pf) {
    const cur = fileContent.get(rel) ?? { exists: false, before: '' };
    pf = {
      file: rel,
      beforeSha256: sha256(cur.before),
      existsBefore: cur.exists,
      afterContent: null,
      diff: null,
      ops: [],
      willChange: false,
    };
    plannedByFile.set(rel, pf);
  }
  pf.ops.push(op);
  if (newContent !== undefined && op.status === 'applied') {
    pf.afterContent = newContent;
    pf.willChange = newContent !== (fileContent.get(rel)?.before ?? '');
    pf.diff = pf.willChange ? diffPreview(fileContent.get(rel)?.before ?? '', newContent) : null;
  }
}


/* ------------------------------------------------------------------ */
/* Stores: run records + custom recipes (atomic JSON, fail-closed)      */
/* ------------------------------------------------------------------ */

export function recipesDataDir(): string {
  return resolve(process.env.AI_FACTORY_DATA_DIR ?? 'data');
}

export function recipeRunsPath(): string {
  const fromEnv = process.env.AI_FACTORY_RECIPES_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(recipesDataDir(), 'recipes.json');
}

export function customRecipesPath(): string {
  const fromEnv = process.env.AI_FACTORY_RECIPES_CUSTOM_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(recipesDataDir(), 'recipes-custom.json');
}

export type RecipeRunStatus =
  | 'planned'
  | 'approval-pending'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'rejected';

export interface VerifyResult {
  kind: 'build' | 'test';
  command: string;
  ok: boolean;
  exitCode: number;
  ms: number;
  output: string;
}

export interface RecipeRun {
  id: string;
  recipeName: string;
  recipeVersion: string;
  projectPath: string;
  /** §23.3 approvals are task-bound by schema; the run may carry the
   *  task the migration is performed for (required to request one). */
  taskId?: string;
  status: RecipeRunStatus;
  plan: RecipePlan;
  approvalId?: string;
  approvedBy?: string;
  verifyResults: VerifyResult[];
  failReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function isRecipeRun(v: unknown): v is RecipeRun {
  if (!isPlainObject(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['recipeName'] === 'string' &&
    typeof v['status'] === 'string' &&
    isPlainObject(v['plan'])
  );
}

export class RecipeRunStore {
  private readonly path: string;
  private runs: RecipeRun[] = [];
  private corrupt = false;

  constructor(path?: string) {
    this.path = path ?? recipeRunsPath();
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { runs?: unknown[] };
      for (const r of raw.runs ?? []) {
        if (isRecipeRun(r)) this.runs.push(r);
      }
    } catch {
      this.corrupt = true;
    }
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private persist(): void {
    if (this.corrupt) throw new RecipeError('STORE_CORRUPT', 'recipe run store is corrupt; writes refused');
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: this.runs }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  list(): RecipeRun[] {
    return this.runs.map((r) => structuredClone(r));
  }

  get(id: string): RecipeRun | undefined {
    const r = this.runs.find((x) => x.id === id);
    return r ? structuredClone(r) : undefined;
  }

  save(run: RecipeRun): void {
    const idx = this.runs.findIndex((x) => x.id === run.id);
    if (idx < 0) this.runs.push(structuredClone(run));
    else this.runs[idx] = structuredClone(run);
    this.persist();
  }

  remove(id: string): boolean {
    const idx = this.runs.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.runs.splice(idx, 1);
    this.persist();
    return true;
  }
}

export class CustomRecipeStore {
  private readonly path: string;
  private recipes: RecipeSpec[] = [];
  private corrupt = false;

  constructor(path?: string) {
    this.path = path ?? customRecipesPath();
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { recipes?: unknown[] };
      for (const r of raw.recipes ?? []) {
        this.recipes.push(validateRecipe(r, 'custom'));
      }
    } catch {
      this.corrupt = true;
      this.recipes = [];
    }
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private persist(): void {
    if (this.corrupt) throw new RecipeError('STORE_CORRUPT', 'custom recipe store is corrupt; writes refused');
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ recipes: this.recipes }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  list(): RecipeSpec[] {
    return this.recipes.map((r) => structuredClone(r));
  }

  add(recipe: RecipeSpec): void {
    if (this.recipes.some((r) => r.name === recipe.name)) {
      throw new RecipeError('RECIPE_CONFLICT', `custom recipe "${recipe.name}" already exists`);
    }
    this.recipes.push(structuredClone(recipe));
    this.persist();
  }

  remove(name: string): boolean {
    const idx = this.recipes.findIndex((r) => r.name === name);
    if (idx < 0) return false;
    this.recipes.splice(idx, 1);
    this.persist();
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Verify runner (exit-code-only, same posture as quality gate)         */
/* ------------------------------------------------------------------ */

export interface ShellResult {
  ok: boolean;
  exitCode: number;
  ms: number;
  output: string;
}

export function runVerifyCommand(cmd: string, cwd: string, timeoutMs = 600_000): Promise<ShellResult> {
  const t0 = Date.now();
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (r: ShellResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(r);
      }
    };
    let child;
    try {
      // V3R14 #6(e): scrub the server's own credential env vars from the
      // ambient inheritance (same rule as pty.ts childEnv).
      child = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: scrubCredentialEnv(process.env) });
    } catch (e) {
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `spawn failed: ${(e as Error).message}` });
      return;
    }
    let out = '';
    let err = '';
    const CAP = 20_480;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > CAP) out = out.slice(0, CAP);
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > CAP) err = err.slice(0, CAP);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `timed out after ${timeoutMs}ms (killed)` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, exitCode: -1, ms: Date.now() - t0, output: `spawn error: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = (out + (err ? `\n[stderr]\n${err}` : '')).slice(0, 41_000);
      const truncated = out.length >= CAP || err.length >= CAP;
      // V3R14 #6(e): redact secret-shaped values from captured output
      // before returning (runhistory precedent: redactText).
      const redacted = redactText(combined);
      done({
        ok: code === 0,
        exitCode: code ?? -1,
        ms: Date.now() - t0,
        output: truncated ? redacted + '\n[output truncated at 20KB/stream — truncation does not affect the exit-code verdict]' : redacted,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Executor: library lookup, plan, approval gate, apply, verify         */
/* ------------------------------------------------------------------ */

export interface AuditHook {
  record(actor: string, event: string, entity: string, entityId: string, details?: Record<string, unknown>): void;
}

/** Central-approval lookup, injected by the routes layer (the routes
 *  layer backs it with @ai-factory/approvals' ApprovalManager). */
export interface ApprovalChecker {
  /** Returns null when the approval id is unknown. */
  getApproval(id: string): { status: string; action: string; requester?: string } | null;
}

export const RECIPE_APPLY_ACTION_PREFIX = 'recipes.apply:';

export function applyActionFor(runId: string): string {
  return `${RECIPE_APPLY_ACTION_PREFIX}${runId}`;
}

export interface RecipeExecutorOptions {
  runStore: RecipeRunStore;
  customStore: CustomRecipeStore;
  audit: AuditHook;
  approvals: ApprovalChecker;
  now?: () => string;
}

/** Deterministic digest of the exact plan content — bound into the
 *  approval as candidate_digest (mirrors plan-mode's plan digest). */
export function planDigest(plan: RecipePlan): string {
  const material = plan.files.map((f) => ({
    file: f.file,
    beforeSha256: f.beforeSha256,
    afterContent: f.afterContent,
    willChange: f.willChange,
  }));
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

export class RecipeExecutor {
  private readonly runStore: RecipeRunStore;
  private readonly customStore: CustomRecipeStore;
  private readonly audit: AuditHook;
  private readonly approvals: ApprovalChecker;
  private readonly now: () => string;

  constructor(opts: RecipeExecutorOptions) {
    this.runStore = opts.runStore;
    this.customStore = opts.customStore;
    this.audit = opts.audit;
    this.approvals = opts.approvals;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  listRecipes(): RecipeSpec[] {
    const builtins = loadBuiltinRecipes();
    const byName = new Map<string, RecipeSpec>();
    for (const r of builtins) byName.set(r.name, r);
    for (const r of this.customStore.list()) {
      if (!byName.has(r.name)) byName.set(r.name, r);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getRecipe(name: string): RecipeSpec | undefined {
    return this.listRecipes().find((r) => r.name === name);
  }

  addCustomRecipe(rawText: string, actor: string): RecipeSpec {
    const recipe = parseRecipeJson(rawText, 'custom');
    if (loadBuiltinRecipes().some((r) => r.name === recipe.name)) {
      throw new RecipeError('RECIPE_CONFLICT', `"${recipe.name}" is a builtin recipe name; custom recipes may not shadow builtins`);
    }
    this.customStore.add(recipe);
    this.audit.record(actor, 'RECIPE_CUSTOM_ADDED', 'recipe', recipe.name, { version: recipe.version, ops: recipe.transform.length });
    return recipe;
  }

  removeCustomRecipe(name: string, actor: string): boolean {
    const removed = this.customStore.remove(name);
    if (removed) this.audit.record(actor, 'RECIPE_CUSTOM_REMOVED', 'recipe', name, {});
    return removed;
  }

  createPlan(recipeName: string, projectPath: string, actor: string, taskId?: string): RecipeRun {
    const recipe = this.getRecipe(recipeName);
    if (!recipe) throw new RecipeError('RECIPE_NOT_FOUND', `recipe "${recipeName}" not found`);
    const plan = computePlan(recipe, projectPath);
    const run: RecipeRun = {
      id: randomUUID(),
      recipeName: recipe.name,
      recipeVersion: recipe.version,
      projectPath: plan.projectPath,
      ...(taskId ? { taskId } : {}),
      status: 'planned',
      plan,
      verifyResults: [],
      createdBy: actor || 'human',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.runStore.save(run);
    this.audit.record(run.createdBy, 'RECIPE_PLAN_CREATED', 'recipe-run', run.id, {
      recipe: recipe.name,
      version: recipe.version,
      project: plan.projectPath,
      applicable: plan.applicable,
      changedFiles: plan.files.filter((f) => f.willChange).map((f) => f.file),
      appliedOps: plan.appliedOps,
      errorOps: plan.errorOps,
      unhandled: plan.unhandled.length,
    });
    return structuredClone(run);
  }

  /** Mark the run as approval-requested (the approval itself is
   *  created by the routes layer via the central approval system). */
  attachApproval(runId: string, approvalId: string, actor: string): RecipeRun {
    const run = this.runStore.get(runId);
    if (!run) throw new RecipeError('RUN_NOT_FOUND', `recipe run ${runId} not found`);
    if (run.status !== 'planned' && run.status !== 'approval-pending') {
      throw new RecipeError('RUN_NOT_PLANNED', `run is in status "${run.status}"; only a planned run can request approval`);
    }
    run.approvalId = approvalId;
    run.status = 'approval-pending';
    run.updatedAt = this.now();
    this.runStore.save(run);
    this.audit.record(actor, 'RECIPE_APPROVAL_REQUESTED', 'recipe-run', run.id, {
      recipe: run.recipeName,
      approvalId,
    });
    return structuredClone(run);
  }

  /**
   * The approval gate. Throws RecipeError (403) unless the injected
   * approval checker reports an APPROVED approval whose action binds
   * it to this exact run (`recipes.apply:<runId>`).
   */
  assertApproved(run: RecipeRun, approvalId: string | undefined, actor: string): { status: string; action: string } {
    if (!approvalId) {
      this.audit.record(actor, 'RECIPE_EXECUTION_REJECTED', 'recipe-run', run.id, { reason: 'missing-approval-id' });
      throw new RecipeError('APPROVAL_REQUIRED', 'execution requires an approvalId from the central approval system (plan → request approval → approve → execute)');
    }
    const approval = this.approvals.getApproval(approvalId);
    if (!approval) {
      this.audit.record(actor, 'RECIPE_EXECUTION_REJECTED', 'recipe-run', run.id, { reason: 'approval-not-found', approvalId });
      throw new RecipeError('APPROVAL_REQUIRED', `approval ${approvalId} not found`);
    }
    if (approval.action !== applyActionFor(run.id)) {
      this.audit.record(actor, 'RECIPE_EXECUTION_REJECTED', 'recipe-run', run.id, {
        reason: 'approval-action-mismatch',
        approvalId,
        approvalAction: approval.action,
      });
      throw new RecipeError('APPROVAL_MISMATCH', `approval ${approvalId} is for action "${approval.action}", not "${applyActionFor(run.id)}"`);
    }
    if (approval.status !== 'APPROVED') {
      this.audit.record(actor, 'RECIPE_EXECUTION_REJECTED', 'recipe-run', run.id, {
        reason: 'approval-not-approved',
        approvalId,
        approvalStatus: approval.status,
      });
      throw new RecipeError('APPROVAL_NOT_APPROVED', `approval ${approvalId} is "${approval.status}", not APPROVED`);
    }
    return approval;
  }

  async executeRun(runId: string, approvalId: string | undefined, actor: string): Promise<RecipeRun> {
    const run = this.runStore.get(runId);
    if (!run) throw new RecipeError('RUN_NOT_FOUND', `recipe run ${runId} not found`);
    if (run.status !== 'planned' && run.status !== 'approval-pending') {
      throw new RecipeError('RUN_NOT_PLANNED', `run is in status "${run.status}"; only a planned run can execute`);
    }
    const recipe = this.getRecipe(run.recipeName);
    if (!recipe) throw new RecipeError('RECIPE_NOT_FOUND', `recipe "${run.recipeName}" no longer exists`);
    if (!run.plan.applicable) {
      throw new RecipeError('BAD_REQUEST', 'plan is not applicable to this project (preconditions not met) — nothing to execute');
    }
    if (run.plan.errorOps > 0) {
      throw new RecipeError('BAD_REQUEST', `plan has ${run.plan.errorOps} error op(s) — fix the project or the recipe and re-plan`);
    }
    // Approval gate (throws 403 + audits RECIPE_EXECUTION_REJECTED).
    this.assertApproved(run, approvalId, actor);

    const projectDir = run.plan.projectPath;
    run.status = 'executing';
    run.updatedAt = this.now();
    this.runStore.save(run);

    // Drift check + apply planned contents verbatim (atomic per file).
    try {
      for (const pf of run.plan.files) {
        if (!pf.willChange || pf.afterContent === null) continue;
        const abs = jailedFile(projectDir, pf.file);
        if (pf.existsBefore) {
          const now = readProjectFile(projectDir, pf.file);
          if (now === null || sha256(now) !== pf.beforeSha256) {
            throw new RecipeError('RECIPE_DRIFT', `${pf.file} changed since the plan was created — refusing to apply a stale plan; re-plan`);
          }
        } else if (existsSync(abs)) {
          throw new RecipeError('RECIPE_DRIFT', `${pf.file} appeared since the plan was created — refusing to overwrite; re-plan`);
        }
        mkdirSync(dirname(abs), { recursive: true });
        const tmp = `${abs}.recipe-${process.pid}.tmp`;
        writeFileSync(tmp, pf.afterContent, 'utf8');
        renameSync(tmp, abs);
        this.audit.record(actor, 'RECIPE_FILE_APPLIED', 'recipe-run', run.id, {
          recipe: run.recipeName,
          file: pf.file,
          ops: pf.ops.filter((o) => o.status === 'applied').length,
        });
      }
    } catch (e) {
      run.status = 'failed';
      run.failReason = (e as Error).message;
      run.updatedAt = this.now();
      this.runStore.save(run);
      this.audit.record(actor, 'RECIPE_RUN_FAILED', 'recipe-run', run.id, { recipe: run.recipeName, error: run.failReason });
      throw e;
    }
    this.audit.record(actor, 'RECIPE_APPLIED', 'recipe-run', run.id, {
      recipe: run.recipeName,
      changedFiles: run.plan.files.filter((f) => f.willChange).map((f) => f.file),
      unhandled: run.plan.unhandled.length,
    });

    // Verify (build/test) — exit-code verdicts, quality-gate posture.
    run.verifyResults = [];
    if (recipe.verify && (recipe.verify.build || recipe.verify.test)) {
      run.status = 'verifying';
      run.updatedAt = this.now();
      this.runStore.save(run);
      const steps: Array<{ kind: 'build' | 'test'; command: string }> = [];
      if (recipe.verify.build) steps.push({ kind: 'build', command: recipe.verify.build });
      if (recipe.verify.test) steps.push({ kind: 'test', command: recipe.verify.test });
      for (const step of steps) {
        const r = await runVerifyCommand(step.command, projectDir);
        run.verifyResults.push({ kind: step.kind, command: step.command, ok: r.ok, exitCode: r.exitCode, ms: r.ms, output: r.output });
        this.audit.record(actor, r.ok ? 'RECIPE_VERIFY_PASSED' : 'RECIPE_VERIFY_FAILED', 'recipe-run', run.id, {
          recipe: run.recipeName,
          kind: step.kind,
          command: step.command,
          exitCode: r.exitCode,
          ms: r.ms,
        });
        if (!r.ok) break;
      }
    }
    const verifyOk = run.verifyResults.every((v) => v.ok);
    run.status = verifyOk ? 'done' : 'failed';
    if (!verifyOk) {
      run.failReason = 'verify failed (files were applied; the project is left in the migrated state for inspection — see verifyResults)';
    }
    run.updatedAt = this.now();
    this.runStore.save(run);
    this.audit.record(actor, verifyOk ? 'RECIPE_RUN_DONE' : 'RECIPE_RUN_FAILED', 'recipe-run', run.id, {
      recipe: run.recipeName,
      verify: run.verifyResults.map((v) => `${v.kind}:${v.ok ? 'ok' : `exit ${v.exitCode}`}`).join(', ') || '(no verify configured)',
    });
    return structuredClone(run);
  }
}
