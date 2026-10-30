/**
 * Static discovery of node:test cases (Round 7 #3).
 *
 * Walks a project root for `*.test.{js,mjs,cjs,ts,mts,cts}` files and
 * parses `describe`/`suite` + `test`/`it` calls (with `.only`/`.skip`/
 * `.todo` suffixes) into a package > file > case tree. No test code is
 * executed here: discovery is a pure line scan, so it is fast and safe
 * on untrusted trees.
 *
 * Known heuristic limits (documented, not silent):
 * - Only `*.test.*` files are discovered; `*.spec.*` files and tests
 *   defined via `test.each` table calls are not picked up.
 * - Describe nesting is tracked by brace counting after stripping
 *   string literals and `//` comments per line. Braces inside template
 *   literals or block comments can mis-nest the chain; the leaf case is
 *   still discovered, only its fullName prefix may be wrong.
 * - Files over `maxFileBytes` are listed with `skipped` set, never parsed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiscoveredCase, DiscoveredFile, DiscoveredPackage, Discovery } from './types';

export interface DiscoverOptions {
  maxVisitedFiles?: number;
  maxTestFiles?: number;
  maxFileBytes?: number;
}

const DEFAULTS = {
  maxVisitedFiles: 5000,
  maxTestFiles: 1000,
  maxFileBytes: 512 * 1024,
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.ai-factory',
  '.next', 'vendor', '__pycache__',
]);

const TEST_FILE = /\.test\.(js|mjs|cjs|ts|mts|cts)$/;

/** describe/suite/test/it call with a string-literal name. */
const CALL_RE =
  /(?:describe|suite|test|it)\s*(?:\.\s*(?:only|skip|todo)\s*)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

function stripForBraces(line: string): string {
  // Remove // comments and string literals so braces inside them do not
  // corrupt nesting. Template literals are NOT stripped (they may span
  // lines); a brace inside one is a known mis-nest case, see header.
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === "'" || ch === '"') {
      const q = ch;
      i += 1;
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function unescapeName(raw: string, quote: string): string {
  if (quote === '`') return raw;
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw.replace(/\\(.)/g, '$1');
  }
}

/** Parse one test file's cases. Pure function over file text. */
/** Call opener with the name on a later line, e.g. `describe(`. */
const OPENER_RE = /^\s*(describe|suite|test|it)\s*(?:\.\s*(?:only|skip|todo)\s*)?\(\s*$/;
/** A line that starts with a string literal (pending call's name). */
const LEADING_STRING_RE = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/;

export function parseTestFile(text: string): DiscoveredCase[] {
  const cases: DiscoveredCase[] = [];
  const stack: Array<{ name: string; openDepth: number; started: boolean }> = [];
  let depth = 0;
  let pendingCall: { keyword: string } | null = null;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] as string;
    // Mark describes whose body has opened (depth reached openDepth);
    // only started describes may be popped. This keeps split-callback
    // describes (`describe(\n 'x',\n () => {`) alive until their body
    // actually opens, instead of popping them on the name line.
    for (const entry of stack) {
      if (!entry.started && entry.openDepth !== -1 && depth >= entry.openDepth) {
        entry.started = true;
      }
    }
    // Pop started describes whose body has closed before this line runs.
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { openDepth: number; started: boolean };
      if (top.started && depth < top.openDepth) stack.pop();
      else break;
    }
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matched = false;
    // Resolve a call whose name landed on a later line.
    if (pendingCall) {
      const sm = LEADING_STRING_RE.exec(line);
      const trimmed = line.trim();
      if (sm) {
        const name = unescapeName(sm[2] as string, sm[1] as string);
        if (pendingCall.keyword === 'describe' || pendingCall.keyword === 'suite') {
          stack.push({ name, openDepth: -1, started: false });
        } else {
          cases.push({ name, fullName: [...stack.map((s) => s.name), name].join(' > '), line: li + 1 });
        }
        pendingCall = null;
        matched = true;
      } else if (trimmed !== '' && !trimmed.startsWith('//')) {
        pendingCall = null; // not a name line: abandon the pending call
      }
    }
    while ((m = CALL_RE.exec(line)) !== null) {
      matched = true;
      const keyword = line.slice(m.index, m.index + 8).split(/[\s.(]/)[0] as string;
      const name = unescapeName(m[2] as string, m[1] as string);
      if (keyword === 'describe' || keyword === 'suite') {
        // openDepth is set after this line's braces are counted below;
        // mark it pending with the pre-line depth + 1 when the line opens
        // a block, otherwise the current depth (single-line describe).
        stack.push({ name, openDepth: -1, started: false });
      } else {
        const fullName = [...stack.map((s) => s.name), name].join(' > ');
        cases.push({ name, fullName, line: li + 1 });
      }
    }
    const stripped = stripForBraces(line);
    const opens = (stripped.match(/{/g) ?? []).length;
    const closes = (stripped.match(/}/g) ?? []).length;
    const depthBefore = depth;
    depth += opens - closes;
    // A bare call opener (`describe(` with nothing after it) leaves its
    // name for a later line.
    if (!matched && !pendingCall && OPENER_RE.test(stripped)) {
      const kw = (stripped.trim().split(/[\s.(]/)[0] as string);
      pendingCall = { keyword: kw };
    }
    // Resolve pending describes opened on this line. A describe body
    // always sits at least one level deeper than the statement itself,
    // which also covers callbacks whose brace lands on a later line.
    // A describe that opened AND closed on this line (closes >= opens
    // with at least one close) is dropped at once: its inner tests on
    // this line were already recorded with the right prefix above.
    const closedSameLine = closes > 0 && closes >= opens;
    for (let si = stack.length - 1; si >= 0; si -= 1) {
      const entry = stack[si] as { name: string; openDepth: number; started: boolean };
      if (entry.openDepth !== -1) continue;
      if (closedSameLine) {
        stack.splice(si, 1);
      } else {
        entry.openDepth = Math.max(depth, depthBefore + 1);
      }
    }
  }
  return cases;
}

function packageNameFor(dir: string, root: string): { name: string; path: string } {
  let cur = dir;
  for (;;) {
    const pkgPath = path.join(cur, 'package.json');
    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown };
      if (typeof raw.name === 'string' && raw.name) return { name: raw.name, path: cur };
    } catch {
      // No/unreadable package.json: keep walking up.
    }
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { name: path.basename(dir) || 'root', path: dir };
}

/** Walk `root` and discover test files. `root` must already be resolved + jailed by the caller. */
export function discoverTests(root: string, opts: DiscoverOptions = {}): Discovery {
  const maxVisitedFiles = opts.maxVisitedFiles ?? DEFAULTS.maxVisitedFiles;
  const maxTestFiles = opts.maxTestFiles ?? DEFAULTS.maxTestFiles;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULTS.maxFileBytes;
  const found: DiscoveredFile[] = [];
  let visited = 0;
  let degraded = false;
  let degradedReason: string | undefined;

  const walk = (dir: string): void => {
    if (degraded) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (degraded) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Never follow symlinked directories (cycle risk).
        if (entry.isSymbolicLink()) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (visited > maxVisitedFiles) {
        degraded = true;
        degradedReason = `visited file cap (${maxVisitedFiles}) reached; discovery is partial`;
        return;
      }
      if (!TEST_FILE.test(entry.name)) continue;
      if (found.length >= maxTestFiles) {
        degraded = true;
        degradedReason = `test file cap (${maxTestFiles}) reached; discovery is partial`;
        return;
      }
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) {
        found.push({ path: abs, rel, cases: [], skipped: `file over ${maxFileBytes} bytes, not parsed` });
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      found.push({ path: abs, rel, cases: parseTestFile(text) });
    }
  };

  walk(root);

  const byKey = new Map<string, DiscoveredPackage>();
  for (const file of found) {
    const dir = path.dirname(file.path);
    const pkg = packageNameFor(dir, root);
    const key = pkg.path;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        name: pkg.name,
        path: pkg.path,
        rel: pkg.path === root ? '.' : path.relative(root, pkg.path).split(path.sep).join('/'),
        files: [],
      };
      byKey.set(key, entry);
    }
    entry.files.push(file);
  }
  const packages = [...byKey.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const p of packages) p.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const totals = {
    packages: packages.length,
    files: found.length,
    cases: found.reduce((n, f) => n + f.cases.length, 0),
  };
  return { root, packages, totals, degraded, degradedReason };
}
