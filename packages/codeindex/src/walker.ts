/**
 * Repository walker: enumerates indexable files under a root.
 *
 * Rules (documented, deterministic):
 *  - Respects .gitignore in the root (simple subset: blank lines and
 *    `#` comments ignored; `!` negations NOT supported and are skipped;
 *    `dir/` matches a directory and everything under it; `*.ext` and
 *    bare names match basenames; `a/b` matches the relative path).
 *  - Always skips: .git, node_modules, dist, build, target,
 *    __pycache__, .venv, venv, vendor, .hg, .svn, coverage.
 *  - Skips binary files (NUL byte in the first 8 KiB) and files larger
 *    than MAX_FILE_BYTES (1 MiB).
 *  - Skips symlinks entirely (never follows them — no escape from the
 *    root via symlink).
 *  - Cap: MAX_FILES (200k); exceeding it stops the walk and reports
 *    `truncated: true`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 200_000;

const ALWAYS_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', '__pycache__',
  '.venv', 'venv', 'vendor', '.hg', '.svn', 'coverage', '.next', '.turbo',
]);

export interface WalkResult {
  /** Absolute paths of indexable files. */
  files: string[];
  /** Directories/files skipped by .gitignore (count only). */
  ignored: number;
  /** Binary or oversize files skipped (count only). */
  skippedBinary: number;
  /** True when MAX_FILES stopped the walk early. */
  truncated: boolean;
}

interface IgnoreRule {
  dirOnly: boolean;
  /** Match against basename. */
  base?: string;
  /** Match against relative posix path (prefix for dirOnly). */
  rel?: string;
  isExtGlob: boolean;
}

function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    const pat = dirOnly ? line.slice(0, -1).replace(/\/+$/, '') : line;
    if (!pat) continue;
    if (pat.includes('/')) {
      rules.push({ dirOnly, rel: pat.replace(/^\//, ''), isExtGlob: false });
    } else if (pat.startsWith('*.')) {
      rules.push({ dirOnly, base: pat, isExtGlob: true });
    } else {
      rules.push({ dirOnly, base: pat, isExtGlob: false });
    }
  }
  return rules;
}

function matchesIgnore(rel: string, base: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) {
      // `dir/` also matches anything underneath it.
      if (r.rel && (rel === r.rel || rel.startsWith(r.rel + '/'))) return true;
      if (r.base && (base === r.base)) return true;
      continue;
    }
    if (r.rel) {
      if (rel === r.rel || (r.dirOnly && rel.startsWith(r.rel + '/'))) return true;
    } else if (r.base) {
      if (r.isExtGlob) {
        const ext = r.base.slice(1); // "*.log" -> ".log"
        if (base.endsWith(ext)) return true;
      } else if (base === r.base) {
        return true;
      }
    }
  }
  return false;
}

async function isBinary(filePath: string): Promise<boolean> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/**
 * Walk `root` (absolute). Returns absolute file paths.
 *
 * `opts.ignore` (optional): an additional exclusion predicate over the
 * absolute path (second arg: true for directories). Directories for
 * which it returns true are PRUNED (never descended into) — this is
 * where the two-tier ignore gate (task ②, @ai-factory/ignores) plugs
 * in: hard-excluded paths never enter the index at all.
 */
export async function walkRepo(
  root: string,
  opts: { ignore?: (abs: string, isDir: boolean) => boolean } = {},
): Promise<WalkResult> {
  const result: WalkResult = { files: [], ignored: 0, skippedBinary: 0, truncated: false };
  let ignoreRules: IgnoreRule[] = [];
  try {
    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ignoreRules = parseGitignore(gi);
  } catch {
    // No .gitignore — fine.
  }

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable dir — skip, don't fail the walk.
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const isDir = e.isDirectory();
      if (e.isSymbolicLink()) continue; // Never follow symlinks.
      if (isDir && ALWAYS_SKIP_DIRS.has(e.name)) continue;
      if (matchesIgnore(rel, e.name, isDir, ignoreRules)) {
        result.ignored++;
        continue;
      }
      if (opts.ignore?.(abs, isDir)) {
        // Two-tier ignore gate (task ②): excluded dirs are pruned,
        // excluded files never enter the index. Counted, never silent.
        result.ignored++;
        continue;
      }
      if (isDir) {
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES || st.size === 0) {
        result.skippedBinary++;
        continue;
      }
      if (await isBinary(abs)) {
        result.skippedBinary++;
        continue;
      }
      result.files.push(abs);
      if (result.files.length >= MAX_FILES) {
        result.truncated = true;
        return result;
      }
    }
  }
  result.files.sort();
  return result;
}
