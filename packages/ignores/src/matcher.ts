/**
 * Gitignore-style pattern matcher (self-implemented, zero dependencies).
 *
 * Deterministic subset of gitignore semantics, documented honestly:
 *
 *   - Blank lines and `#` comments are skipped. `\#` / `\!` escape to a
 *     literal `#` / `!`. Trailing whitespace is stripped unless escaped.
 *   - `!` prefix negates the pattern; the LAST matching pattern wins.
 *   - A pattern with no `/` (besides a trailing one) matches the BASENAME
 *     at any depth (`*.log` matches `a/b/c.log`).
 *   - A pattern containing `/` is ANCHORED to the root
 *     (`/build/out` or `build/out` matches only `build/out` from the root).
 *   - A trailing `/` marks a DIRECTORY-only pattern. When a directory is
 *     excluded, everything under it is excluded too — and this is STICKY:
 *     a deeper negation (e.g. `!secrets/keep.txt` when `secrets/` is
 *     excluded) cannot re-include the file, mirroring git's "it is not
 *     possible to re-include a file if a parent directory of that file is
 *     excluded". This is the safe direction for a privacy gate.
 *   - `*` matches any run of characters except `/` (one path segment),
 *     `?` matches exactly one character except `/`, `**` matches any
 *     number of path segments (including zero), `[...]` is a character
 *     class.
 *
 * HONEST BOUNDARY: this is STRING matching, not semantic understanding.
 * `*.pem` does not know what a PEM file is — it matches the name.
 */

export interface CompiledIgnorePattern {
  /** The pattern text after comment/negation/trailing-slash processing. */
  source: string;
  /** 1-based line number in the ignore file (for UI surfacing). */
  line: number;
  /** `!`-negated pattern. */
  negated: boolean;
  /** Trailing-`/` directory-only pattern. */
  dirOnly: boolean;
  /** Contains `/` → anchored to the root; otherwise basename match. */
  anchored: boolean;
  /** Matches a posix relative path (full-string match). */
  regex: RegExp;
}

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile one glob body (no leading `!`, no trailing `/`) to a RegExp
 * source string. `*` → `[^/]*`, `?` → `[^/]`, `**` → `.*`,
 * `**\/` → `(?:.*\/)?` (zero or more segments), `\/ **` at the end →
 * `(?:\/.*)?`, `[...]` character classes pass through.
 */
function globToSource(glob: string): string {
  let out = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i] as string;
    // Trailing `/**` (e.g. `a/**`) matches the directory itself AND
    // everything below it — without this the ancestor-dir pruning in
    // evaluateIgnore would miss the directory itself.
    if (c === '/' && glob[i + 1] === '*' && glob[i + 2] === '*' && i + 3 === n) {
      out += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[') {
      // Character class: copy through to the closing `]`, escaping
      // backslashes; an unterminated class is treated as a literal `[`.
      let j = i + 1;
      let cls = '';
      if (glob[j] === '!') {
        cls += '^';
        j += 1;
      } else if (glob[j] === '^') {
        cls += '\\^';
        j += 1;
      }
      if (glob[j] === ']') {
        cls += '\\]';
        j += 1;
      }
      let closed = false;
      while (j < n) {
        const d = glob[j] as string;
        if (d === ']') {
          closed = true;
          break;
        }
        cls += d === '\\' ? '\\\\' : d;
        j += 1;
      }
      if (closed) {
        out += `[${cls}]`;
        i = j + 1;
      } else {
        out += '\\[';
        i += 1;
      }
    } else if (c === '\\' && i + 1 < n) {
      out += escapeRegExpChar(glob[i + 1] as string);
      i += 2;
    } else {
      out += escapeRegExpChar(c);
      i += 1;
    }
  }
  return out;
}

/**
 * Parse one raw line of an ignore file. Returns null for blank lines and
 * comments (skipped, not errors — gitignore files are line-oriented and
 * forgiving).
 */
export function parseIgnoreLine(
  rawLine: string,
  line: number,
): CompiledIgnorePattern | null {
  // Strip trailing whitespace unless escaped with a backslash.
  let s = rawLine;
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) {
    if (end >= 2 && s[end - 2] === '\\') break;
    end -= 1;
  }
  s = s.slice(0, end);
  if (s.trim() === '') return null;
  if (s.startsWith('#')) return null;
  let body = s;
  // Unescape a leading `\#` / `\!`.
  if (body.startsWith('\\#') || body.startsWith('\\!')) body = body.slice(1);

  let negated = false;
  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  }
  if (body.trim() === '') return null;

  let dirOnly = false;
  if (body.endsWith('/')) {
    dirOnly = true;
    body = body.replace(/\/+$/, '');
    if (body === '') return null;
  }

  // Anchored when the body contains a `/` (a leading `/` also anchors).
  const anchored = body.includes('/');
  const pat = body.replace(/^\//, '');

  const globSrc = globToSource(pat);
  const source = anchored ? `^${globSrc}$` : `^(?:.*/)?${globSrc}$`;
  return {
    source: pat,
    line,
    negated,
    dirOnly,
    anchored,
    regex: new RegExp(source),
  };
}

/** Parse a whole ignore file text into compiled patterns (in file order). */
export function parseIgnoreText(text: string): CompiledIgnorePattern[] {
  const out: CompiledIgnorePattern[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const p = parseIgnoreLine(lines[i] as string, i + 1);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Evaluate `rel` (posix path relative to the ignore root) against the
 * patterns, in git-faithful order:
 *
 *  1. Each ancestor directory, shallowest first, is evaluated against the
 *     patterns (as a directory). The first excluded ancestor excludes
 *     `rel` — STICKY: deeper negations cannot re-include it.
 *  2. Otherwise `rel` itself is evaluated; the last matching pattern
 *     decides (negated → not ignored).
 *
 * dirOnly patterns only match directories (ancestors always count as
 * directories; `rel` itself only when `isDir` is true).
 */
export function evaluateIgnore(
  rel: string,
  isDir: boolean,
  patterns: readonly CompiledIgnorePattern[],
): { ignored: boolean; pattern?: CompiledIgnorePattern } {
  if (rel === '' || rel === '.') return { ignored: false };
  const segs = rel.split('/');
  // 1. Ancestor directories, shallowest first (sticky exclusion).
  for (let depth = 1; depth < segs.length; depth++) {
    const ancestor = segs.slice(0, depth).join('/');
    const verdict = lastMatch(ancestor, true, patterns);
    if (verdict && !verdict.negated) {
      return { ignored: true, pattern: verdict };
    }
  }
  // 2. The path itself.
  const verdict = lastMatch(rel, isDir, patterns);
  if (verdict && !verdict.negated) return { ignored: true, pattern: verdict };
  return { ignored: false };
}

function lastMatch(
  rel: string,
  isDir: boolean,
  patterns: readonly CompiledIgnorePattern[],
): CompiledIgnorePattern | null {
  let hit: CompiledIgnorePattern | null = null;
  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.regex.test(rel)) hit = p;
  }
  return hit;
}
