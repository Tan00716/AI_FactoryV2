/**
 * TODO/FIXME tracker (round-4 task B9) — JetBrains TODO tool-window style.
 *
 * What it is: a deterministic, regex-based scanner that walks a project
 * root and reports TODO/FIXME/BUG/HACK-style task comments as structured
 * items { file, line, column, severity, tag, message }. Custom patterns
 * (name + regexp + severity) are supported; the desktop renders a tool
 * window list plus editor gutter / overview-ruler markers. No model, no
 * inference: a line either matches a pattern or it is skipped.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. This is NOT comment-aware. Regexes do not understand code: a
 *     TODO inside a string literal or prose matches exactly like one in
 *     a comment. False positives are the operator's trade-off for a
 *     zero-dependency scanner; custom patterns tune the noise.
 *  2. Matching is case-sensitive (JetBrains default). `todo` lowercase
 *     does not match the builtin TODO pattern.
 *  3. Results are a snapshot of the files at scan time. Nothing here
 *     watches the filesystem; the desktop re-scans on demand.
 *  4. Patterns run in the server process with no ReDoS sandbox. They
 *     are validated (length-capped, must compile, must not match the
 *     empty string) but a hostile pattern is the operator's own
 *     foot-gun — same trust posture as problem-matcher regexes.
 *  5. Item messages are single-line, trimmed and length-capped. They
 *     are developer-written source text, not untrusted external
 *     content, so no sanitizeUntrusted() quarantine is applied.
 *
 * This module is pure node builtins with no sibling value imports, so
 * server tests may import it straight from src under node's
 * type-stripping ESM loader (dual-mode import rule — see AGENTS.md).
 * The walk mirrors apps/server/src/inspections.ts conventions
 * (sorted entries, symlink-free, binary sniff, size cap) but scans ALL
 * text files rather than an extension allowlist — task comments live in
 * docs and scripts too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type TodoSeverity = 'error' | 'warning' | 'info';

export interface TodoPattern {
  /** Tag name shown in the UI, e.g. 'FIXME'. */
  name: string;
  /** Per-line pattern. Capture group 1 (optional) becomes the message. */
  regexp: string;
  severity: TodoSeverity;
  enabled: boolean;
  builtin: boolean;
}

export interface TodoItem {
  /** Workspace-relative posix path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column where the tag match starts. */
  column: number;
  severity: TodoSeverity;
  /** Name of the pattern that matched. */
  tag: string;
  /** Captured message: single line, trimmed, capped. */
  message: string;
}

export interface TodoScanStats {
  filesScanned: number;
  linesScanned: number;
  items: number;
  truncated: boolean;
  skippedBinary: number;
  durationMs: number;
}

export interface TodoScanOptions {
  patterns?: TodoPattern[];
  /** Extra exclusion predicate over the absolute path (dirs are pruned). */
  ignore?: (abs: string, isDir: boolean) => boolean;
  /** File cap; defaults to MAX_TODO_SCAN_FILES. */
  maxFiles?: number;
  now?: () => number;
}

export class TodoScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoScanError';
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', '__pycache__', 'target', '.idea', '.vscode', '.turbo',
]);
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_TODO_SCAN_FILES = 20_000;
const MAX_PATTERNS = 32;
const MAX_PATTERN_NAME = 64;
const MAX_PATTERN_REGEXP = 512;
const MAX_MESSAGE_CHARS = 300;

export const DEFAULT_TODO_PATTERNS: TodoPattern[] = [
  { name: 'FIXME', regexp: '\\bFIXME\\b\\s*:?\\s*(.*)$', severity: 'error', enabled: true, builtin: true },
  { name: 'BUG', regexp: '\\bBUG\\b\\s*:?\\s*(.*)$', severity: 'error', enabled: true, builtin: true },
  { name: 'HACK', regexp: '\\bHACK\\b\\s*:?\\s*(.*)$', severity: 'warning', enabled: true, builtin: true },
  { name: 'TODO', regexp: '\\bTODO\\b\\s*:?\\s*(.*)$', severity: 'info', enabled: true, builtin: true },
];

function isTodoSeverity(v: unknown): v is TodoSeverity {
  return v === 'error' || v === 'warning' || v === 'info';
}

/**
 * Validate a caller-supplied pattern list. Returns normalized patterns
 * (builtin forced false, enabled defaulting true). Throws TodoScanError
 * naming the offending pattern — fail-closed, never half-applied.
 */
export function validateTodoPatterns(input: unknown): TodoPattern[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TodoScanError('patterns must be a non-empty array');
  }
  if (input.length > MAX_PATTERNS) {
    throw new TodoScanError(`too many patterns (max ${MAX_PATTERNS})`);
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const p = raw as Record<string, unknown>;
    const name = typeof p['name'] === 'string' ? p['name'].trim() : '';
    if (!name || name.length > MAX_PATTERN_NAME) {
      throw new TodoScanError(`pattern[${i}]: name must be 1-${MAX_PATTERN_NAME} chars`);
    }
    const key = name.toUpperCase();
    if (seen.has(key)) throw new TodoScanError(`pattern[${i}]: duplicate name "${name}"`);
    seen.add(key);
    const regexp = typeof p['regexp'] === 'string' ? p['regexp'] : '';
    if (!regexp || regexp.length > MAX_PATTERN_REGEXP) {
      throw new TodoScanError(`pattern "${name}": regexp must be 1-${MAX_PATTERN_REGEXP} chars`);
    }
    let re: RegExp;
    try {
      re = new RegExp(regexp);
    } catch (e) {
      throw new TodoScanError(`pattern "${name}": invalid regexp: ${(e as Error).message}`);
    }
    // A pattern matching the empty string would tag every line.
    if (re.test('')) {
      throw new TodoScanError(`pattern "${name}": regexp must not match the empty string`);
    }
    const severity = p['severity'];
    if (!isTodoSeverity(severity)) {
      throw new TodoScanError(`pattern "${name}": severity must be error|warning|info`);
    }
    const enabled = p['enabled'] === undefined ? true : p['enabled'] === true;
    return { name, regexp, severity, enabled, builtin: false };
  });
}

/** Compile validated patterns once per scan. */
function compilePatterns(patterns: TodoPattern[]): Array<{ pattern: TodoPattern; re: RegExp }> {
  const out: Array<{ pattern: TodoPattern; re: RegExp }> = [];
  for (const p of patterns) {
    if (!p.enabled) continue;
    out.push({ pattern: p, re: new RegExp(p.regexp) });
  }
  return out;
}

interface CollectedFile { rel: string; abs: string }

function collectFiles(root: string, ignore: ((abs: string, isDir: boolean) => boolean) | undefined, maxFiles: number): { files: CollectedFile[]; truncated: boolean } {
  const files: CollectedFile[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (files.length >= maxFiles) { truncated = true; return; }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
    } catch {
      return; // Unreadable dir — skip, don't fail the scan.
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // Never follow symlinks.
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (ignore) {
        try {
          if (ignore(abs, e.isDirectory())) continue;
        } catch {
          continue; // A throwing predicate excludes the path.
        }
      }
      if (e.isDirectory()) {
        walk(abs);
        if (truncated) return;
      } else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        files.push({ rel, abs });
        if (files.length >= maxFiles) { truncated = true; return; }
      }
    }
  };
  walk(root);
  return { files, truncated };
}

function readTextLines(abs: string): { lines: string[] } | { binary: true } {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return { binary: true };
    const buf = readFileSync(abs);
    if (buf.subarray(0, 4096).includes(0)) return { binary: true };
    return { lines: buf.toString('utf8').split('\n') };
  } catch {
    return { binary: true };
  }
}

function cleanMessage(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Scan one absolute file path for task comments. The caller must jail
 * `abs` to the scan root first. Returns [] for binary/oversize files.
 */
export function scanTodoFile(abs: string, root: string, patterns?: TodoPattern[]): TodoItem[] {
  const list = patterns ?? DEFAULT_TODO_PATTERNS;
  const compiled = compilePatterns(list);
  if (compiled.length === 0) return [];
  const read = readTextLines(abs);
  if ('binary' in read) return [];
  const rel = relative(resolve(root), abs).split(sep).join('/');
  const items: TodoItem[] = [];
  const lines = read.lines;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] as string;
    if (line.length > 4096) continue;
    for (const { pattern, re } of compiled) {
      const m = re.exec(line);
      if (!m || m.index === undefined) continue;
      const rawMsg = m.length > 1 && m[1] !== undefined ? String(m[1]) : m[0];
      items.push({
        file: rel,
        line: li + 1,
        column: m.index + 1,
        severity: pattern.severity,
        tag: pattern.name,
        message: cleanMessage(rawMsg),
      });
      break;
    }
  }
  return items;
}

/**
 * Scan `root` (absolute) for task comments. Deterministic: files are
 * walked in sorted order, patterns apply in config order, lines ascend.
 * Throws TodoScanError when the root is unusable.
 */
export function scanTodos(root: string, opts: TodoScanOptions = {}): { items: TodoItem[]; stats: TodoScanStats } {
  const t0 = (opts.now ?? Date.now)();
  const absRoot = resolve(root);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absRoot);
  } catch {
    throw new TodoScanError(`scan root does not exist: ${root}`);
  }
  if (!st.isDirectory()) throw new TodoScanError(`scan root is not a directory: ${root}`);
  const patterns = opts.patterns ?? DEFAULT_TODO_PATTERNS;
  const compiled = compilePatterns(patterns);
  const maxFiles = opts.maxFiles ?? MAX_TODO_SCAN_FILES;
  const { files, truncated } = collectFiles(absRoot, opts.ignore, maxFiles);
  const items: TodoItem[] = [];
  let linesScanned = 0;
  let skippedBinary = 0;
  for (const f of files) {
    const read = readTextLines(f.abs);
    if ('binary' in read) { skippedBinary++; continue; }
    const lines = read.lines;
    linesScanned += lines.length;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li] as string;
      if (line.length > 4096) continue; // Absurdly long lines are not task comments.
      for (const { pattern, re } of compiled) {
        const m = re.exec(line);
        if (!m || m.index === undefined) continue;
        const rawMsg = m.length > 1 && m[1] !== undefined ? String(m[1]) : m[0];
        items.push({
          file: f.rel,
          line: li + 1,
          column: m.index + 1,
          severity: pattern.severity,
          tag: pattern.name,
          message: cleanMessage(rawMsg),
        });
        break; // One pattern per line: first config match wins.
      }
    }
  }
  const t1 = (opts.now ?? Date.now)();
  return {
    items,
    stats: {
      filesScanned: files.length,
      linesScanned,
      items: items.length,
      truncated,
      skippedBinary,
      durationMs: Math.max(0, t1 - t0),
    },
  };
}
