/**
 * Index builder: walks a root, extracts symbols, builds the inverted
 * index, and persists it as JSON (atomic temp+rename write).
 *
 * Incremental update: each FileRecord carries the file's mtime+size at
 * index time. On rebuild, files whose mtime+size are unchanged are
 * reused verbatim — only changed/new files are re-read and re-parsed.
 * Deleted files are dropped. The inverted index is rebuilt from the
 * file records (cheap relative to I/O).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSymbols } from './extract.js';
import type { FileRecord, IndexData, IndexStats, Posting } from './types.js';
import { MAX_FILE_BYTES, walkRepo } from './walker.js';

export const INDEX_VERSION = 1;
/** Cap postings per token so a common word can't blow up the index. */
export const MAX_POSTINGS_PER_TOKEN = 5000;

/** Tokenize a line: lowercase alnum words (len>=2) + camelCase splits. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  for (const raw of line.split(/[^A-Za-z0-9_]+/)) {
    if (raw.length < 2) continue;
    const lower = raw.toLowerCase();
    out.push(lower);
    // camelCase / PascalCase split: "buildIndex" -> "build", "index".
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    if (parts.length > 1) {
      for (const p of parts) {
        if (p.length >= 2) out.push(p.toLowerCase());
      }
    }
  }
  return out;
}

/** Default on-disk location for a root's index JSON. */
export function indexFilePath(cacheDir: string, root: string): string {
  const safe = root.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return path.join(cacheDir, `${safe}.json`);
}

export function defaultCacheDir(): string {
  const base = process.env.FACTORY_DATA_DIR || path.join(os.homedir(), '.ai-factory');
  return path.join(base, 'codeindex');
}

async function readTextSafe(abs: string): Promise<string | null> {
  try {
    const st = await fs.stat(abs);
    if (st.size > MAX_FILE_BYTES || st.size === 0) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build (or incrementally refresh) the index for `root`.
 * `root` must already be absolute and realpath-resolved by the caller.
 * Returns the index plus stats.
 */
export async function buildIndex(
  root: string,
  opts: { cacheDir?: string; previous?: IndexData } = {},
): Promise<{ index: IndexData; stats: IndexStats }> {
  const walk = await walkRepo(root);
  const prevByRel = new Map<string, FileRecord>();
  if (opts.previous) {
    for (const f of opts.previous.files) prevByRel.set(f.rel, f);
  }

  const files: FileRecord[] = [];
  let reused = 0;
  let bytes = 0;
  for (const abs of walk.files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    const prev = prevByRel.get(rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      files.push(prev);
      reused++;
      bytes += prev.size;
      continue;
    }
    const text = await readTextSafe(abs);
    if (text === null) continue;
    const ext = path.extname(abs);
    const tokens: Record<string, number> = {};
    const lines = text.split('\n');
    for (let ln = 0; ln < lines.length; ln++) {
      for (const tok of tokenize(lines[ln])) {
        if (!(tok in tokens)) tokens[tok] = ln + 1;
      }
    }
    files.push({
      rel,
      mtimeMs: st.mtimeMs,
      size: st.size,
      symbols: extractSymbols(rel, ext, text),
      tokens,
    });
    bytes += st.size;
  }

  // Inverted index assembled from per-file token maps — unchanged files
  // are never re-read (their FileRecord, tokens included, is reused).
  const inverted: Record<string, Posting[]> = {};
  const addPosting = (token: string, posting: Posting) => {
    let arr = inverted[token];
    if (!arr) {
      arr = [];
      inverted[token] = arr;
    }
    if (arr.length < MAX_POSTINGS_PER_TOKEN) arr.push(posting);
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    for (const tok of Object.keys(f.tokens)) {
      addPosting(tok, [i, f.tokens[tok]]);
    }
  }

  const symbols = files.flatMap((f) => f.symbols);
  const index: IndexData = {
    version: INDEX_VERSION,
    root,
    builtAt: Date.now(),
    files,
    symbols,
    inverted,
  };
  const stats: IndexStats = {
    root,
    files: files.length,
    symbols: symbols.length,
    tokens: Object.keys(inverted).length,
    bytes,
    builtAt: index.builtAt,
    full: reused === 0,
  };
  // Note: callers persist via saveIndex(); build is pure w.r.t. disk.
  return { index, stats };
}

/** Atomically write the index JSON to the cache dir. */
export async function saveIndex(cacheDir: string, index: IndexData): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true });
  const dest = indexFilePath(cacheDir, index.root);
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index));
  await fs.rename(tmp, dest);
  return dest;
}

/** Load a previously saved index, or null when absent/corrupt. */
export async function loadIndex(cacheDir: string, root: string): Promise<IndexData | null> {
  try {
    const raw = await fs.readFile(indexFilePath(cacheDir, root), 'utf8');
    const data = JSON.parse(raw) as IndexData;
    if (data.version !== INDEX_VERSION || data.root !== root) return null;
    return data;
  } catch {
    return null;
  }
}
