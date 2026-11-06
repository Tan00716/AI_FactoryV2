/**
 * Index-free project grep. Walks the tree deterministically (sorted
 * entries, no symlink following, binary sniff, size caps) and matches
 * line by line — literal substring or RegExp, per the query.
 *
 * No sibling value imports (dual-mode import rule): node builtins only,
 * so server tests can import this straight from src.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  CodeSearchError,
  CodeSearchFileGroup,
  CodeSearchMatch,
  CodeSearchOptions,
  CodeSearchQuery,
  CodeSearchResult,
  CodeSearchStats,
  NormalizedCodeSearchQuery,
} from './types.js';

export const DEFAULT_MAX_MATCHES = 2000;
export const HARD_MAX_MATCHES = 10000;
const MAX_QUERY_LEN = 200;
const MAX_GLOBS = 8;
const MAX_GLOB_LEN = 200;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_FILES_WALKED = 20000;
const MAX_LINE_CHARS = 500;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', '__pycache__', 'target', '.idea', '.vscode', '.turbo',
  // R16 N2 defense-in-depth: the server data dir (mutation run reports,
  // flaky history, …) must never be searchable — persisted reports can
  // hold child output, and search hits are returned verbatim.
  'data',
]);

/** Fail-closed normalization of a caller query. Throws CodeSearchError. */
export function normalizeQuery(q: CodeSearchQuery): NormalizedCodeSearchQuery {
  if (!q || typeof q !== 'object') throw new CodeSearchError('query must be an object');
  const query = q.query;
  if (typeof query !== 'string' || !query.trim()) {
    throw new CodeSearchError('query is required and must be non-empty');
  }
  if (query.length > MAX_QUERY_LEN) {
    throw new CodeSearchError(`query exceeds ${MAX_QUERY_LEN} characters`);
  }
  const regex = q.regex === true;
  const caseSensitive = q.caseSensitive === true;
  let globs: string[] = [];
  if (q.glob !== undefined) {
    const raw = Array.isArray(q.glob) ? q.glob : String(q.glob).split(',');
    globs = raw.map((g) => g.trim().replace(/\\/g, '/')).filter((g) => g.length > 0);
    if (globs.length > MAX_GLOBS) throw new CodeSearchError(`at most ${MAX_GLOBS} glob patterns`);
    for (const g of globs) {
      if (g.length > MAX_GLOB_LEN) throw new CodeSearchError('glob pattern too long');
    }
  }
  let maxMatches = q.maxMatches ?? DEFAULT_MAX_MATCHES;
  if (typeof maxMatches !== 'number' || !Number.isFinite(maxMatches)) {
    throw new CodeSearchError('maxMatches must be a number');
  }
  maxMatches = Math.min(HARD_MAX_MATCHES, Math.max(1, Math.floor(maxMatches)));
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, caseSensitive ? '' : 'i');
    } catch {
      throw new CodeSearchError('regex does not compile');
    }
    if (re.test('')) throw new CodeSearchError('regex must not match the empty string');
  }
  return { query: query, regex, caseSensitive, globs, maxMatches };
}

/** Convert a simple glob (`*`, `**`, `?`) to a RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // `/**/` should also match zero directories: `a/**/b` matches `a/b`.
        if (glob[i + 1] === '/') {
          out += '/?';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

function buildMatcher(nq: NormalizedCodeSearchQuery): (line: string) => number {
  if (nq.regex) {
    const flags = 'g' + (nq.caseSensitive ? '' : 'i');
    return (line: string) => {
      const re = new RegExp(nq.query, flags);
      const m = re.exec(line);
      return m ? m.index + 1 : 0;
    };
  }
  const needle = nq.caseSensitive ? nq.query : nq.query.toLowerCase();
  return (line: string) => {
    const hay = nq.caseSensitive ? line : line.toLowerCase();
    const idx = hay.indexOf(needle);
    return idx >= 0 ? idx + 1 : 0;
  };
}

/** NUL-byte sniff of the first 8 KiB: binary files are skipped. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk `root` and grep every text file. Deterministic: sorted entries,
 * ascending lines, files in ascending path order. Stops early (with
 * truncated=true) when HARD caps are hit — never silently partial.
 */
export function grepProject(
  root: string,
  query: CodeSearchQuery,
  opts: CodeSearchOptions = {},
): CodeSearchResult {
  const nq = normalizeQuery(query);
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const globRes = nq.globs.map(globToRegExp);
  const matchesFor = buildMatcher(nq);
  const groups: CodeSearchFileGroup[] = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let linesScanned = 0;
  let skippedBinary = 0;
  let skippedTooLarge = 0;
  let filesWalked = 0;
  let truncated = false;

  const ignored = opts.ignore;

  function walk(dir: string): void {
    if (truncated) return;
    let entries: Array<{ name: string; abs: string; isDir: boolean; isFile: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => ({
          name: e.name,
          abs: join(dir, e.name),
          isDir: e.isDirectory(),
          isFile: e.isFile(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return; // unreadable dir: skip, not fail
    }
    for (const e of entries) {
      if (truncated) return;
      if (ignored?.(e.abs, e.isDir)) continue;
      if (e.isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(e.abs);
        continue;
      }
      if (!e.isFile) continue; // symlinks and specials are never followed
      filesWalked++;
      if (filesWalked > MAX_FILES_WALKED) {
        truncated = true;
        return;
      }
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(e.abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        skippedTooLarge++;
        continue;
      }
      const rel = relative(root, e.abs).split(sep).join('/');
      if (globRes.length > 0 && !globRes.some((r) => r.test(rel))) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(e.abs);
      } catch {
        continue;
      }
      if (isBinary(buf)) {
        skippedBinary++;
        continue;
      }
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const group: CodeSearchFileGroup = { file: rel, matches: [] };
      for (let i = 0; i < lines.length; i++) {
        const col = matchesFor(lines[i]);
        if (col > 0) {
          const m: CodeSearchMatch = {
            file: rel,
            line: i + 1,
            column: col,
            text: lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) : lines[i],
          };
          group.matches.push(m);
          totalMatches++;
          if (totalMatches >= nq.maxMatches) {
            truncated = true;
            if (group.matches.length > 0) groups.push(group);
            return;
          }
        }
      }
      linesScanned += lines.length;
      filesScanned++;
      if (group.matches.length > 0) groups.push(group);
    }
  }

  walk(root);

  const stats: CodeSearchStats = {
    filesScanned,
    linesScanned,
    skippedBinary,
    skippedTooLarge,
    truncated,
    durationMs: now() - t0,
  };
  return { query: nq, groups, totalMatches, stats };
}
