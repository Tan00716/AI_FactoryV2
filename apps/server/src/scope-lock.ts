/**
 * Scope Lock — task-level edit scope (second-round strengthening, item 8;
 * bolt.new "Limit editing to specific files" style).
 *
 * A task may carry an optional scope:
 *   { include: string[], exclude: string[] }
 * Glob patterns relative to the task's workspace root. No scope (or an
 * empty scope) means "unrestricted" — exactly the pre-existing behavior.
 *
 * WHAT THIS MODULE IS: pure logic only — glob matching, input
 * validation/normalization, path-jail resolution and out-of-scope
 * detection. No sibling src imports (node builtins + @ai-factory/core
 * types only), so server tests can import it straight from src under
 * node type-stripping (dual-mode import rule, AGENTS.md).
 *
 * ENFORCEMENT POINTS (wired elsewhere, honestly bounded):
 *  - POST /api/file with a `taskId` attribution (routes/files.ts):
 *    pre-write check — a write attributed to a scoped task is REFUSED
 *    before it lands, with SCOPE_LOCKED + a SCOPE_VIOLATION audit.
 *  - POST /api/recipes/plan with a taskId (routes/recipes.ts):
 *    plan-time check — a plan whose target files escape the scope is
 *    refused (422), never silently trimmed.
 *  - Post-hoc detection (routes/scope.ts): files an exec/shell command
 *    changed indirectly are compared against the scope from the task's
 *    shadow-checkpoint diff at run end / on demand. DETECTED, audited
 *    (SCOPE_VIOLATION_DETECTED) and surfaced in the UI — never
 *    auto-rolled-back: undo is the human's decision (shadow restore).
 *
 * HONEST BOUNDARIES (repeated in the UI copy):
 *  - Manual editing in the editor is NOT restricted — by design. The
 *    lock constrains work done *for* a task (attributed writes, recipe
 *    runs, agent loops), never the human's own editor.
 *  - Shell/exec commands can write anywhere their sandbox tier allows;
 *    there is no per-write interception on that surface. Such writes are
 *    caught post-hoc by the shadow-diff check, not blocked in real time.
 *  - A write through /api/file WITHOUT task attribution cannot be
 *    scope-checked (the lock is task-scoped); it is audited as before.
 *  - Patterns are matched against paths relative to the workspace root
 *    of the surface being checked (file-API workspace root / recipe
 *    project root / shadow workspace). Glob matching is our own small
 *    deterministic matcher supporting `**`, `*`, `?` and character
 *    classes are NOT supported — it is not full minimatch.
 *  - Symlink semantics: a write path is judged by its RESOLVED real
 *    path (best-effort realpath of the deepest existing ancestor), so a
 *    symlink inside the workspace that points outside is treated as an
 *    escape, exactly like the project's other path jails.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { TaskEditScope } from '@ai-factory/core';

export type { TaskEditScope };

/** Machine-readable refusal code for scope-lock denials. */
export const SCOPE_LOCKED_CODE = 'SCOPE_LOCKED';

export type ScopeDenyReason =
  /** Path is not covered by any `include` pattern. */
  | 'not-included'
  /** Path is covered by an `exclude` pattern (exclude always wins). */
  | 'excluded'
  /** Resolved real path escapes the workspace root (incl. via symlink). */
  | 'escape';

export class ScopeLockDeniedError extends Error {
  readonly code = SCOPE_LOCKED_CODE;
  readonly relPath: string;
  readonly reason: ScopeDenyReason;
  constructor(relPath: string, reason: ScopeDenyReason) {
    super(
      reason === 'escape'
        ? `scope lock: '${relPath}' resolves outside the workspace root`
        : reason === 'excluded'
          ? `scope lock: '${relPath}' is excluded by the task scope`
          : `scope lock: '${relPath}' is not included in the task scope`,
    );
    this.name = 'ScopeLockDeniedError';
    this.relPath = relPath;
    this.reason = reason;
  }
}

// ------------------------------------------------------------ globbing --

/** Normalize a glob pattern: backslashes → '/', strip leading './' and '/'. */
export function normalizeGlob(pattern: string): string {
  let p = pattern.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

/** Normalize a workspace-relative path the same way (posix separators). */
export function normalizeRelPath(rel: string): string {
  let p = rel.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Compile one glob pattern to an anchored RegExp.
 *  `**` — any number of path segments (including zero);
 *  `*`  — any run of non-separator chars;
 *  `?`  — exactly one non-separator char.
 *  A pattern with no glob characters matches itself and, like a
 *  directory entry in .gitignore-style configs, its whole subtree
 *  (`src` matches `src/a.ts`) — that is the intuitive reading of a
 *  bare directory in an include/exclude list. */
export function globToRegExp(pattern: string): RegExp {
  const p = normalizeGlob(pattern);
  const literal = /^[^*?]+$/.test(p);
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` possibly followed by `/`
        if (p[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(REGEXP_SPECIALS, '\\$&');
    }
  }
  // Bare directory / exact-file literal also matches its subtree.
  const suffix = literal ? '(?:/.*)?' : '';
  return new RegExp(`^${out}${suffix}$`);
}

/** Match a relative path against one glob pattern. Case-sensitive. */
export function matchGlob(pattern: string, relPath: string): boolean {
  return globToRegExp(pattern).test(normalizeRelPath(relPath));
}

// ----------------------------------------------------------- validation --

export interface ScopeValidation {
  /** Present when the input was a valid scope object (possibly empty). */
  scope?: TaskEditScope;
  /** Present when the input was malformed — scope must NOT be applied. */
  error?: string;
}

const MAX_PATTERNS = 200;
const MAX_PATTERN_LEN = 256;

/**
 * Validate + normalize raw API input into a TaskEditScope. Malformed
 * input yields `error` — callers refuse with 400 INVALID_SCOPE rather
 * than silently dropping a security-relevant control the caller asked
 * for. `null` input is the explicit "clear the scope" signal and
 * yields an empty (unrestricted) scope object.
 */
export function validateScopeInput(raw: unknown): ScopeValidation {
  if (raw === null) return { scope: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'scope must be an object { include?: string[], exclude?: string[] }' };
  }
  const obj = raw as Record<string, unknown>;
  const out: TaskEditScope = {};
  for (const key of ['include', 'exclude'] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return { error: `scope.${key} must be an array of glob strings` };
    if (v.length > MAX_PATTERNS) {
      return { error: `scope.${key} has too many patterns (max ${MAX_PATTERNS})` };
    }
    const patterns: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string') {
        return { error: `scope.${key} entries must be strings` };
      }
      const err = validateGlobPattern(item);
      if (err) return { error: `scope.${key}: ${err}` };
      const norm = normalizeGlob(item);
      if (norm && !patterns.includes(norm)) patterns.push(norm);
    }
    if (patterns.length > 0) out[key] = patterns;
  }
  return { scope: out };
}

/** One pattern's validity: relative, no parent refs, no control chars. */
export function validateGlobPattern(pattern: string): string | null {
  if (pattern.length === 0) return 'empty pattern';
  if (pattern.length > MAX_PATTERN_LEN) return `pattern too long (max ${MAX_PATTERN_LEN})`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return 'pattern contains control characters';
  const p = normalizeGlob(pattern);
  if (isAbsolute(pattern.replace(/\\/g, '/')) || /^[a-zA-Z]:/.test(pattern)) {
    return 'patterns must be relative to the workspace root';
  }
  if (p.split('/').some((seg) => seg === '..')) {
    return 'patterns must not contain .. segments';
  }
  return null;
}

/** True when the scope restricts anything at all. */
export function hasScope(scope: TaskEditScope | null | undefined): boolean {
  if (!scope) return false;
  return (scope.include?.length ?? 0) > 0 || (scope.exclude?.length ?? 0) > 0;
}

// ------------------------------------------------------------ matching --

export interface ScopeVerdict {
  allowed: boolean;
  reason?: ScopeDenyReason;
}

/**
 * Judge a workspace-relative path against a scope.
 *  - exclude match → denied ('excluded') — exclude ALWAYS wins;
 *  - non-empty include with no match → denied ('not-included');
 *  - empty include = no inclusion constraint.
 */
export function judgePath(scope: TaskEditScope, relPath: string): ScopeVerdict {
  const rel = normalizeRelPath(relPath);
  for (const pat of scope.exclude ?? []) {
    if (matchGlob(pat, rel)) return { allowed: false, reason: 'excluded' };
  }
  const include = scope.include ?? [];
  if (include.length > 0 && !include.some((pat) => matchGlob(pat, rel))) {
    return { allowed: false, reason: 'not-included' };
  }
  return { allowed: true };
}

/** Convenience: allowed iff judged allowed. */
export function scopeAllows(scope: TaskEditScope, relPath: string): boolean {
  return judgePath(scope, relPath).allowed;
}

/** The out-of-scope subset of `relPaths`, each with its deny reason. */
export function detectOutOfScopePaths(
  scope: TaskEditScope,
  relPaths: readonly string[],
): { path: string; reason: ScopeDenyReason }[] {
  const out: { path: string; reason: ScopeDenyReason }[] = [];
  const seen = new Set<string>();
  for (const raw of relPaths) {
    const rel = normalizeRelPath(raw);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const v = judgePath(scope, rel);
    if (!v.allowed && v.reason) out.push({ path: rel, reason: v.reason });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// --------------------------------------------------------- path jail ----

/**
 * Resolve `rawPath` against `workspaceRoot` and judge it for a scoped
 * write. The path is judged by its RESOLVED real location: the deepest
 * existing ancestor is realpath'd (so a symlink inside the workspace
 * pointing outside resolves to the outside target), and any escape
 * from the root is denied with reason 'escape' — the same posture as
 * the project's other path jails. Throws ScopeLockDeniedError on
 * escape; otherwise returns the workspace-relative posix path.
 */
export function resolveScopedRel(workspaceRoot: string, rawPath: string): string {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, rawPath);
  // Deepest existing ancestor → realpath (symlink resolution).
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realAbs = abs;
  try {
    const realProbe = realpathSync(probe);
    realAbs = probe === abs ? realProbe : resolve(realProbe, relative(probe, abs));
  } catch {
    /* no realpath available (e.g. exotic fs) — fall back to resolve() */
  }
  const rel = relative(root, realAbs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ScopeLockDeniedError(normalizeRelPath(rawPath), 'escape');
  }
  return normalizeRelPath(rel);
}

/**
 * Full pre-write check for one path under a scope: jail resolution,
 * then scope judging. Throws ScopeLockDeniedError when denied.
 * Returns the workspace-relative path when allowed.
 */
export function checkScopedWrite(
  scope: TaskEditScope,
  workspaceRoot: string,
  rawPath: string,
): string {
  const rel = resolveScopedRel(workspaceRoot, rawPath);
  const verdict = judgePath(scope, rel);
  if (!verdict.allowed && verdict.reason) {
    throw new ScopeLockDeniedError(rel, verdict.reason);
  }
  return rel;
}

// -------------------------------------------------------------- presets --

export interface ScopePreset {
  id: string;
  include?: string[];
  exclude?: string[];
}

/** Built-in presets offered by the desktop scope editor. */
export const SCOPE_PRESETS: readonly ScopePreset[] = [
  { id: 'src-only', include: ['src/**'] },
  { id: 'src-and-tests', include: ['src/**', 'tests/**', 'test/**'] },
  { id: 'docs-only', include: ['docs/**', '*.md'] },
  { id: 'no-config', exclude: ['*.json', '*.yaml', '*.yml', '*.toml', 'config/**'] },
  { id: 'no-secrets', exclude: ['**/.env*', '**/*.pem', '**/*.key', 'secrets/**'] },
];
