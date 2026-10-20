/**
 * Deterministic @-context providers (task ⑥, third strengthening wave).
 *
 * Continue.dev-style `@name` / `@name(arg)` references that resolve to
 * DETERMINISTIC snapshots — git state, terminal transcripts, the
 * quality-gate's own run history, directory trees, the desktop's
 * registered open files. No model, no inference, no guessing.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. Every provider output is a snapshot, never understanding. @problems
 *     only reports what the quality gate actually recorded — it cannot
 *     see lint errors that were never run.
 *  2. Terminal output is UNTRUSTED external content (it can contain
 *     attacker-controlled bytes). ALL provider output is quarantined
 *     through sanitizeUntrusted() — treated strictly as DATA, directive
 *     lines stripped, never as instructions.
 *  3. Token counts are a chars/4 ESTIMATE, labeled as such. They are not
 *     measured against any tokenizer.
 *  4. Path jail: @diff/@tree only operate inside FACTORY_CODEINDEX_ROOTS
 *     (fail-closed when unset, same convention as @ai-factory/codeindex).
 *     There is no fallback root and no silent default.
 *  5. @terminal reads only live in-process terminal sessions (the same
 *     process that serves the API). Closed sessions are gone — the
 *     provider says so instead of inventing a transcript.
 *  6. @open only lists files the desktop client registered via
 *     POST /api/context-providers/open-files. When nothing is
 *     registered it says so; it does NOT guess from mtime.
 *  7. (Task ②) @tree/@diff/@open consult deps.isIgnored (the two-tier
 *     ignore gate): hard-ignored paths are hidden with an explicit
 *     notice/count, never silently. The gate constrains only these AI
 *     surfaces — the operator's own exec/terminal/editor is ungated.
 *
 * This module is pure node builtins (+ @ai-factory/security, a real
 * package dep) with type-only sibling imports, so server tests may
 * import it straight from src under node's type-stripping ESM loader
 * (dual-mode import rule — see AGENTS.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sanitizeUntrusted } from '@ai-factory/security';

/** A parsed `@name` / `@name(arg)` reference found in text. */
export interface ContextRef {
  /** Provider name, e.g. 'diff'. */
  name: string;
  /** Raw argument inside the parens, or null when no parens were given. */
  arg: string | null;
  /** The exact matched text, e.g. '@diff(src/a.ts)'. */
  raw: string;
}

/** Machine-readable description of one provider (served by GET /api/context-providers). */
export interface ProviderMeta {
  name: string;
  description: string;
  usage: string;
  takesArg: boolean;
  argHint?: string;
}

/** One deterministic problem item (quality-gate history or matcher-parsed output). */
export interface QualityProblem {
  source: 'quality-gate' | 'problem-matcher';
  kind: string;
  ok: boolean;
  detail: string;
  at: string;
}

/** A resolved provider reference: sanitized, capped, honestly labeled. */
export interface ResolvedContext {
  provider: string;
  arg: string | null;
  /** Human-readable provenance, e.g. 'git diff HEAD in /abs/root'. */
  source: string;
  /** sanitizeUntrusted()-quarantined content. */
  text: string;
  truncated: boolean;
  /** chars/4 ESTIMATE — never presented as a measured token count. */
  estimatedTokens: number;
}

/**
 * Dependencies a provider needs from the host process. Injected by the
 * route layer (routes/context-providers.ts) so this module stays pure
 * and unit-testable without a server.
 */
export interface ProviderDeps {
  /** Workspace root for @diff/@tree; null when none is configured. */
  workspaceRoot(): string | null;
  /** Tail of a terminal transcript; found:false when nothing is available. */
  terminalTail(
    sessionId: string | null,
    maxLines: number,
  ): { found: boolean; sessionId?: string; text?: string; note?: string };
  /** Deterministic problem history for a project (may be empty). */
  qualityProblems(projectId: string | null): QualityProblem[];
  /** Files the desktop client registered as open (may be empty). */
  openFiles(): string[];
  /**
   * Two-tier ignore gate (task ②), optional: (absPath) → true when the
   * path is hard-excluded by `.ai-factory/ignore` and must not enter
   * provider output. The indexing tier does NOT apply here (an
   * indexing-ignored file may still be explicitly referenced — that is
   * the documented two-tier semantics). Callers that omit this dep get
   * the pre-gate behavior (nothing is hidden).
   */
  isIgnored?: (absPath: string) => boolean;
}

export type ContextProviderErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'ROOT_UNAVAILABLE'
  | 'ROOT_DENIED'
  | 'GIT_UNAVAILABLE'
  | 'TERMINAL_UNAVAILABLE';

export class ContextProviderError extends Error {
  readonly code: ContextProviderErrorCode;
  constructor(code: ContextProviderErrorCode, message: string) {
    super(message);
    this.name = 'ContextProviderError';
    this.code = code;
  }
}

export const CONTEXT_PROVIDER_NAMES = ['diff', 'terminal', 'problems', 'tree', 'open'] as const;

export const CONTEXT_PROVIDER_METAS: ProviderMeta[] = [
  {
    name: 'diff',
    description: 'Current git diff (staged + unstaged) as deterministic context',
    usage: '@diff or @diff(path/to/file.ts)',
    takesArg: true,
    argHint: 'optional file path inside the workspace root',
  },
  {
    name: 'terminal',
    description: 'Tail of a terminal session transcript (most recent, or by id)',
    usage: '@terminal or @terminal(200) or @terminal(<sessionId>)',
    takesArg: true,
    argHint: 'line count (digits) or a terminal session id',
  },
  {
    name: 'problems',
    description:
      'Last quality-gate lint/test results plus problem-matcher diagnostics parsed from terminal/gate/scheduler output (deterministic history only)',
    usage: '@problems',
    takesArg: false,
  },
  {
    name: 'tree',
    description: 'Directory tree of the workspace (excludes node_modules/dist/.git)',
    usage: '@tree or @tree(6) or @tree(sub/dir)',
    takesArg: true,
    argHint: 'depth (digits) or a subdirectory inside the workspace root',
  },
  {
    name: 'open',
    description: 'Files the desktop client registered as open (registered only, never guessed)',
    usage: '@open',
    takesArg: false,
  },
];

/**
 * Parse `@name` / `@name(arg)` references out of text. The negative
 * lookbehind keeps emails (foo@bar.com) and @@-escapes out of the match
 * set. Unknown names are KEPT here — the resolver turns them into an
 * explicit UNKNOWN_PROVIDER error instead of silently dropping them.
 */
export function parseContextRefs(text: string): ContextRef[] {
  const refs: ContextRef[] = [];
  const re = /(?<![\w@])@([a-z][a-z0-9_-]*)(\(([^()]*)\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push({ name: m[1], arg: m[3] !== undefined ? m[3] : null, raw: m[0] });
  }
  return refs;
}

/** Allowed workspace roots — FACTORY_CODEINDEX_ROOTS, fail-closed when unset. */
export function contextAllowedRoots(): string[] {
  return (process.env.FACTORY_CODEINDEX_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

/**
 * Resolve a root inside the path jail. null input → the first allowed
 * root. Throws ROOT_UNAVAILABLE when nothing is configured, ROOT_DENIED
 * when the input escapes the allowed roots.
 */
export function resolveJailedRoot(input: string | null): string {
  const roots = contextAllowedRoots();
  if (input === null || input === undefined) {
    if (roots.length === 0) {
      throw new ContextProviderError(
        'ROOT_UNAVAILABLE',
        'no workspace root configured: set FACTORY_CODEINDEX_ROOTS',
      );
    }
    return roots[0];
  }
  const abs = resolve(input);
  for (const r of roots) {
    const rel = relative(r, abs);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs;
  }
  throw new ContextProviderError(
    'ROOT_DENIED',
    `path is outside the allowed workspace roots: ${input}`,
  );
}

/** Resolve a path strictly inside a jail root (for @diff(file) / @tree(subdir)). */
function resolveJailedPath(root: string, input: string): string {
  const abs = resolve(root, input);
  const rel = relative(root, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs;
  throw new ContextProviderError('ROOT_DENIED', `path escapes the workspace root: ${input}`);
}

/** Cap bytes, mark truncation honestly. */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.byteLength(text, 'utf8');
  if (buf <= maxBytes) return { text, truncated: false };
  // Cut on a byte boundary without splitting a UTF-8 sequence.
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let cut = bytes.toString('utf8');
  cut = cut.replace(/\uFFFD+$/, '');
  return {
    text: `${cut}\n… [truncated: provider output exceeded ${maxBytes} bytes]`,
    truncated: true,
  };
}

function finish(
  provider: string,
  arg: string | null,
  source: string,
  raw: string,
  maxBytes: number,
): ResolvedContext {
  const capped = capBytes(raw, maxBytes);
  const sanitized = sanitizeUntrusted(capped.text).sanitized;
  return {
    provider,
    arg,
    source,
    text: sanitized,
    truncated: capped.truncated,
    estimatedTokens: Math.ceil(sanitized.length / 4),
  };
}

const DIFF_MAX_BYTES = 200 * 1024;
const TERMINAL_MAX_BYTES = 100 * 1024;
const TREE_MAX_BYTES = 100 * 1024;
const PROBLEMS_MAX_BYTES = 50 * 1024;
const OPEN_MAX_BYTES = 100 * 1024;

function resolveDiff(ref: ContextRef, deps: ProviderDeps): ResolvedContext {
  const root = deps.workspaceRoot();
  if (!root) {
    throw new ContextProviderError(
      'ROOT_UNAVAILABLE',
      'no workspace root configured: set FACTORY_CODEINDEX_ROOTS',
    );
  }
  let paths: string[] = [];
  if (ref.arg !== null && ref.arg.trim() !== '') {
    const f = resolveJailedPath(root, ref.arg.trim());
    // Explicit file reference to a hard-ignored file: refuse with an
    // explicit notice instead of silently serving the content or
    // silently dropping it. (Cursor's .cursorignore semantics: the file
    // is invisible to every AI surface.)
    if (deps.isIgnored?.(f)) {
      return finish(
        'diff',
        ref.arg,
        `git diff HEAD in ${root} (file: ${relative(root, f) || '.'})`,
        `(refused: ${relative(root, f) || '.'} is excluded by .ai-factory/ignore — ` +
          'hard-ignored files are invisible to AI surfaces; the ignore gate ' +
          'cannot stop your own exec/terminal from reading it)',
        DIFF_MAX_BYTES,
      );
    }
    paths = [relative(root, f) || '.'];
  }
  const args = ['-C', root, 'diff', 'HEAD', '--', ...paths];
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
  } catch (e) {
    throw new ContextProviderError(
      'GIT_UNAVAILABLE',
      `could not run git: ${(e as Error).message}`,
    );
  }
  if (r.error) {
    throw new ContextProviderError(
      'GIT_UNAVAILABLE',
      `could not run git: ${(r.error as Error).message}`,
    );
  }
  if (r.status !== 0) {
    const stderr = String(r.stderr ?? '').slice(0, 200);
    throw new ContextProviderError(
      'GIT_UNAVAILABLE',
      `git diff failed (is this a git repository?)${stderr ? `: ${stderr}` : ''}`,
    );
  }
  const out = String(r.stdout ?? '');
  let body = out.trim() === '' ? '(no changes: working tree is clean)' : out;
  // Whole-tree diff: drop per-file sections for hard-ignored files
  // (task ②). Section headers are `diff --git a/x b/y`; a section whose
  // a- or b-side path is hard-ignored is removed and its removal is
  // counted in an explicit trailer — never silent.
  if (paths.length === 0 && deps.isIgnored && out.trim() !== '') {
    const kept: string[] = [];
    let dropped = 0;
    const sections = body.split(/(?=^diff --git )/m);
    for (const sec of sections) {
      const m = /^diff --git a\/(.+) b\/(.+)$/m.exec(sec);
      if (!m) {
        kept.push(sec);
        continue;
      }
      const a = join(root, (m[1] as string).trim());
      const b = join(root, (m[2] as string).trim());
      if (deps.isIgnored(a) || deps.isIgnored(b)) dropped += 1;
      else kept.push(sec);
    }
    if (dropped > 0) {
      body =
        kept.join('').trimEnd() +
        `\n… [${dropped} changed file(s) hidden by .ai-factory/ignore]`;
    }
  }
  return finish(
    'diff',
    ref.arg,
    `git diff HEAD in ${root}${paths.length > 0 ? ` (file: ${paths[0]})` : ''}`,
    body,
    DIFF_MAX_BYTES,
  );
}

function resolveTerminal(ref: ContextRef, deps: ProviderDeps): ResolvedContext {
  const arg = (ref.arg ?? '').trim();
  let sessionId: string | null = null;
  let lines = 200;
  if (/^\d+$/.test(arg)) {
    lines = Math.min(2000, Math.max(1, parseInt(arg, 10)));
  } else if (arg !== '') {
    sessionId = arg;
  }
  const t = deps.terminalTail(sessionId, lines);
  if (!t.found) {
    return finish(
      'terminal',
      ref.arg,
      'terminal transcript (unavailable)',
      `(no terminal output attached: ${t.note ?? 'unavailable'} — terminal sessions are process-local and closed sessions are gone)`,
      TERMINAL_MAX_BYTES,
    );
  }
  return finish(
    'terminal',
    ref.arg,
    `terminal transcript tail (${lines} lines) of session ${t.sessionId}`,
    t.text ?? '',
    TERMINAL_MAX_BYTES,
  );
}

function resolveProblems(ref: ContextRef, deps: ProviderDeps, projectId: string | null): ResolvedContext {
  const items = deps.qualityProblems(projectId);
  let body: string;
  if (items.length === 0) {
    body =
      '(no quality-gate runs recorded for this project yet — @problems only reports ' +
      'deterministic quality-gate history; it cannot see failures that were never run)';
  } else {
    body = items
      .map(
        (p) =>
          `${p.kind}: ${p.ok ? 'PASS' : 'FAIL'} — ${p.detail} (at ${p.at})`,
      )
      .join('\n');
  }
  return finish(
    'problems',
    ref.arg,
    projectId
      ? `quality-gate history for project ${projectId}`
      : 'quality-gate history (no project)',
    body,
    PROBLEMS_MAX_BYTES,
  );
}

const TREE_EXCLUDES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'coverage',
  '.venv',
  '__pycache__',
  '.cache',
  'dist-electron',
]);

function resolveTree(ref: ContextRef, deps: ProviderDeps): ResolvedContext {
  const root = deps.workspaceRoot();
  if (!root) {
    throw new ContextProviderError(
      'ROOT_UNAVAILABLE',
      'no workspace root configured: set FACTORY_CODEINDEX_ROOTS',
    );
  }
  const arg = (ref.arg ?? '').trim();
  let depth = 4;
  let startDir = root;
  let source = `directory tree of ${root} (depth ${depth})`;
  if (/^\d+$/.test(arg)) {
    depth = Math.min(8, Math.max(1, parseInt(arg, 10)));
    source = `directory tree of ${root} (depth ${depth})`;
  } else if (arg !== '') {
    startDir = resolveJailedPath(root, arg);
    source = `directory tree of ${relative(root, startDir) || '.'} in ${root} (depth ${depth})`;
  }
  const lines: string[] = [];
  const MAX_ENTRIES = 3000;
  let entries = 0;
  let hitCap = false;
  const walk = (dir: string, d: number, prefix: string): void => {
    if (d > depth || hitCap) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    const visible = names.filter(
      (n) => !TREE_EXCLUDES.has(n) && !n.startsWith('.') && !deps.isIgnored?.(join(dir, n)),
    );
    for (let i = 0; i < visible.length; i++) {
      if (hitCap) return;
      const n = visible[i];
      const last = i === visible.length - 1;
      const p = join(dir, n);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      entries += 1;
      if (entries > MAX_ENTRIES) {
        hitCap = true;
        return;
      }
      lines.push(`${prefix}${last ? '└── ' : '├── '}${n}${isDir ? '/' : ''}`);
      if (isDir) walk(p, d + 1, `${prefix}${last ? '    ' : '│   '}`);
    }
  };
  if (!existsSync(startDir)) {
    throw new ContextProviderError('ROOT_DENIED', `directory does not exist: ${arg}`);
  }
  // @tree of a hard-ignored directory: an explicit notice, not an empty
  // lie (the listing is hidden by the gate on purpose).
  if (arg !== '' && !/^\d+$/.test(arg) && deps.isIgnored?.(startDir)) {
    return finish(
      'tree',
      ref.arg,
      source,
      '(directory excluded by .ai-factory/ignore — hard-ignored paths are not listed)',
      TREE_MAX_BYTES,
    );
  }
  walk(startDir, 1, '');
  if (hitCap) lines.push(`… [truncated: more than ${MAX_ENTRIES} entries]`);
  return finish('tree', ref.arg, source, lines.join('\n') || '(empty directory)', TREE_MAX_BYTES);
}

function resolveOpen(ref: ContextRef, deps: ProviderDeps): ResolvedContext {
  const files = deps.openFiles();
  // Hard-ignored registered files are hidden with an explicit count
  // (task ②) — the registration may name them, the context must not.
  const visible = deps.isIgnored ? files.filter((f) => !deps.isIgnored!(f)) : files;
  const hidden = files.length - visible.length;
  let body =
    files.length === 0
      ? '(no open files registered — the desktop client registers them via ' +
        'POST /api/context-providers/open-files; @open never guesses)'
      : visible.join('\n');
  if (hidden > 0) {
    body += `\n(${hidden} registered file(s) hidden by .ai-factory/ignore)`;
  }
  return finish(
    'open',
    ref.arg,
    `open files registered by the desktop client (${visible.length})`,
    body,
    OPEN_MAX_BYTES,
  );
}

export interface ResolveOptions {
  deps: ProviderDeps;
  projectId?: string | null;
}

export interface ResolveResult {
  /** Input text with each @ref replaced inline by its resolved context block. */
  text: string;
  resolved: ResolvedContext[];
}

/**
 * Resolve every @-reference in `text`, replacing each occurrence inline
 * with a labeled <context> block. Each unique (provider, arg) pair is
 * resolved once. The replacement is a single pass over the ORIGINAL
 * text (String.replace with a callback): inserted blocks are never
 * rescanned, so provider output that literally mentions "@diff" cannot
 * recurse, and `@diff` can never corrupt a neighboring `@diff()`.
 * Unknown provider names throw UNKNOWN_PROVIDER — the caller turns that
 * into a 400, never a silently-dropped reference.
 */
export function resolveContextRefs(text: string, opts: ResolveOptions): ResolveResult {
  const resolved: ResolvedContext[] = [];
  const cache = new Map<string, ResolvedContext>();
  const resolveOne = (name: string, arg: string | null): ResolvedContext => {
    const key = `${name}\n${arg ?? ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const ref: ContextRef = { name, arg, raw: arg !== null ? `@${name}(${arg})` : `@${name}` };
    let rc: ResolvedContext;
    switch (name) {
      case 'diff':
        rc = resolveDiff(ref, opts.deps);
        break;
      case 'terminal':
        rc = resolveTerminal(ref, opts.deps);
        break;
      case 'problems':
        rc = resolveProblems(ref, opts.deps, opts.projectId ?? null);
        break;
      case 'tree':
        rc = resolveTree(ref, opts.deps);
        break;
      case 'open':
        rc = resolveOpen(ref, opts.deps);
        break;
      default:
        throw new ContextProviderError(
          'UNKNOWN_PROVIDER',
          `unknown context provider: @${name} (known: ${CONTEXT_PROVIDER_NAMES.map((n) => '@' + n).join(', ')})`,
        );
    }
    cache.set(key, rc);
    resolved.push(rc);
    return rc;
  };
  const re = /(?<![\w@])@([a-z][a-z0-9_-]*)(\(([^()]*)\))?/g;
  const out = text.replace(re, (raw, name: string, _paren: string, arg: string | undefined) => {
    const rc = resolveOne(name, arg === undefined ? null : arg);
    return (
      `<context provider="${rc.provider}" source="${escapeAttr(rc.source)}" ` +
      `estimatedTokens~="${rc.estimatedTokens}" truncated="${rc.truncated}">\n` +
      `${rc.text}\n</context>`
    );
  });
  return { text: out, resolved };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
