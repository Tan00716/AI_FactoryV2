/**
 * Query API over a built IndexData.
 *
 *   searchSymbols(index, query) — substring match on symbol names
 *     (case-insensitive); exact and prefix matches rank first.
 *   searchText(index, query)    — token lookup in the inverted index;
 *     multi-token queries rank files matching more tokens first.
 *   getDefinition(index, name)  — exact symbol-name match (case-sensitive
 *     first, then case-insensitive).
 *
 * Results carry file + line + snippet so callers can verify in source.
 * `withContext` attaches a few surrounding lines (requires the root).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tokenize } from './indexer.js';
import type { CodeSymbol, IndexData, SearchHit } from './types.js';

export interface QueryOptions {
  /** Max hits returned (default 20). */
  limit?: number;
  /** Attach ±contextLines of source around each hit (default 0). */
  contextLines?: number;
  /** Root dir used to read source for context/snippets. */
  root?: string;
}

function rankSymbol(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

export function searchSymbols(
  index: IndexData,
  query: string,
  opts: QueryOptions = {},
): SearchHit[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const scored: Array<{ s: CodeSymbol; r: number }> = [];
  for (const s of index.symbols) {
    const r = rankSymbol(s.name, q);
    if (r < 3) scored.push({ s, r });
  }
  scored.sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map(({ s }) => ({
    file: s.file,
    line: s.line,
    snippet: s.snippet,
    symbol: s.name,
    kind: s.kind,
  }));
}

export function searchText(
  index: IndexData,
  query: string,
  opts: QueryOptions = {},
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const limit = opts.limit ?? 20;
  // fileIdx -> {count, firstLine}
  const acc = new Map<number, { count: number; line: number }>();
  for (const tok of tokens) {
    const postings = index.inverted[tok];
    if (!postings) continue;
    for (const [fi, ln] of postings) {
      const cur = acc.get(fi);
      if (cur) {
        cur.count++;
        if (ln < cur.line) cur.line = ln;
      } else {
        acc.set(fi, { count: 1, line: ln });
      }
    }
  }
  const ranked = [...acc.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].line - b[1].line)
    .slice(0, limit);
  return ranked.map(([fi, v]) => ({
    file: index.files[fi].rel,
    line: v.line,
    snippet: '',
    score: v.count,
  }));
}

export function getDefinition(
  index: IndexData,
  name: string,
): SearchHit[] {
  const exact = index.symbols.filter((s) => s.name === name);
  const list = exact.length > 0
    ? exact
    : index.symbols.filter((s) => s.name.toLowerCase() === name.toLowerCase());
  return list.map((s) => ({
    file: s.file,
    line: s.line,
    snippet: s.snippet,
    symbol: s.name,
    kind: s.kind,
  }));
}

/** Attach source context lines to hits (best-effort; missing file → hit unchanged). */
export async function withContext(
  root: string,
  hits: SearchHit[],
  contextLines = 2,
): Promise<SearchHit[]> {
  const cache = new Map<string, string[]>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    let lines = cache.get(h.file);
    if (lines === undefined) {
      try {
        const text = await fs.readFile(path.join(root, h.file), 'utf8');
        lines = text.split('\n');
      } catch {
        lines = [];
      }
      cache.set(h.file, lines);
    }
    if (lines.length === 0) {
      out.push(h);
      continue;
    }
    const start = Math.max(0, h.line - 1 - contextLines);
    const end = Math.min(lines.length, h.line + contextLines);
    out.push({
      ...h,
      snippet: h.snippet || lines[h.line - 1]?.trim() || '',
      context: lines.slice(start, end).join('\n'),
    });
  }
  return out;
}
