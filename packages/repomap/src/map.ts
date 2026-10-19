/**
 * Repo map builder: IndexData → importance-ranked structural summary.
 *
 * Pipeline:
 *   1. Group codeindex symbols by file (signature = the definition line).
 *   2. Reference counting (heuristic): a symbol's `refs` = number of
 *      *other* files whose token set contains the symbol's name.
 *      Name-based, not semantic — same-named symbols in different
 *      scopes are conflated. Documented as a limitation, not hidden.
 *   3. Importance scoring: kind-weighted base × log(refs), plus one
 *      deterministic propagation pass (PageRank-lite): a symbol gains
 *      a fraction of the average score of symbols defined in files
 *      that reference it.
 *   4. Sort files by total score (desc), symbols within a file by
 *      score (desc); every tie broken by path/line/name so output is
 *      byte-stable across runs.
 *   5. Render markdown; drop least-important files past the token
 *      budget and mark the cut explicitly.
 */

import type { CodeSymbol, IndexData } from '@ai-factory/codeindex';
import type { BuildMapOptions, MapFile, MapSymbol, RepoMapData } from './types.js';
import { estimateTokens } from './tokens.js';

export const MAP_VERSION = 1 as const;
/** Default token budget for the rendered markdown. */
export const DEFAULT_MAX_TOKENS = 20000;

/** Kind-weighted base importance. */
const KIND_BASE: Record<string, number> = {
  class: 3,
  struct: 3,
  trait: 3,
  interface: 3,
  enum: 3,
  function: 2,
  method: 1.5,
  variable: 1,
  type: 1,
  export: 1,
};

function baseOf(kind: string): number {
  return KIND_BASE[kind] ?? 1;
}

interface Scored {
  sym: CodeSymbol;
  refs: number;
  score: number;
}

/**
 * Build the ranked map from a codeindex IndexData. Pure function of
 * its inputs — same index in, byte-identical map out.
 *
 * `totals` describe the full pre-truncation map; `map.files` is the
 * budget-truncated keep-list actually rendered.
 */
export function buildRepoMap(
  index: IndexData,
  opts: BuildMapOptions = {},
): {
  map: RepoMapData;
  markdown: string;
  totals: { files: number; symbols: number; refs: number };
} {
  const maxTokens = Math.min(
    100000,
    Math.max(100, Math.floor(opts.maxTokens ?? DEFAULT_MAX_TOKENS)),
  );

  // 1. Group symbols by file (sorted for determinism).
  const byFile = new Map<string, CodeSymbol[]>();
  for (const s of index.symbols) {
    const arr = byFile.get(s.file);
    if (arr) arr.push(s);
    else byFile.set(s.file, [s]);
  }
  const sortedFiles = [...index.files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // Token set per file (lowercase, from codeindex).
  const tokenSets = new Map<string, Set<string>>();
  for (const f of sortedFiles) tokenSets.set(f.rel, new Set(Object.keys(f.tokens)));

  // name → defining files (a name may be defined in several files).
  const defFiles = new Map<string, Set<string>>();
  for (const s of index.symbols) {
    const key = s.name.toLowerCase();
    let set = defFiles.get(key);
    if (!set) {
      set = new Set();
      defFiles.set(key, set);
    }
    set.add(s.file);
  }

  // 2. Heuristic reference counts.
  const scored = new Map<CodeSymbol, Scored>();
  const nameRefs = new Map<string, number>();
  for (const s of index.symbols) {
    const key = s.name.toLowerCase();
    let refs = nameRefs.get(key);
    if (refs === undefined) {
      const definers = defFiles.get(key) ?? new Set<string>();
      let count = 0;
      for (const f of sortedFiles) {
        if (definers.has(f.rel)) continue;
        if (tokenSets.get(f.rel)?.has(key)) count++;
      }
      refs = count;
      nameRefs.set(key, refs);
    }
    const base = baseOf(s.kind);
    scored.set(s, { sym: s, refs, score: base * (1 + Math.log1p(refs)) });
  }

  // 3. One deterministic propagation pass: symbols defined in files
  //    that reference a name lend it a quarter of their average score.
  //    (files referencing `name` = files whose tokens contain it,
  //    excluding the name's own defining files.)
  const fileAvg = new Map<string, number>();
  for (const f of sortedFiles) {
    const syms = byFile.get(f.rel) ?? [];
    fileAvg.set(
      f.rel,
      syms.length === 0
        ? 0
        : syms.reduce((acc, s) => acc + (scored.get(s)?.score ?? 0), 0) / syms.length,
    );
  }
  for (const s of index.symbols) {
    const key = s.name.toLowerCase();
    const definers = defFiles.get(key) ?? new Set<string>();
    let sum = 0;
    let n = 0;
    for (const f of sortedFiles) {
      if (definers.has(f.rel)) continue;
      if (tokenSets.get(f.rel)?.has(key)) {
        sum += fileAvg.get(f.rel) ?? 0;
        n++;
      }
    }
    const entry = scored.get(s);
    if (entry && n > 0) entry.score = entry.score + 0.25 * (sum / n);
  }

  // 4. Assemble files, sorted by importance (ties → path).
  const mapFiles: MapFile[] = sortedFiles.map((f) => {
    const syms = (byFile.get(f.rel) ?? [])
      .map((s) => {
        const e = scored.get(s);
        return {
          name: s.name,
          kind: s.kind,
          file: s.file,
          line: s.line,
          signature: s.snippet,
          refs: e?.refs ?? 0,
          score: round2(e?.score ?? 0),
        } satisfies MapSymbol;
      })
      .sort((a, b) => b.score - a.score || a.line - b.line || (a.name < b.name ? -1 : 1));
    const score = round2(syms.reduce((acc, s) => acc + s.score, 0));
    return { file: f.rel, score, symbols: syms, fileOnly: syms.length === 0 } satisfies MapFile;
  });
  mapFiles.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));

  const totals = {
    files: mapFiles.length,
    symbols: mapFiles.reduce((acc, f) => acc + f.symbols.length, 0),
    refs: mapFiles.reduce(
      (acc, f) => acc + f.symbols.reduce((a, s) => a + s.refs, 0),
      0,
    ),
  };

  // 5. Render, then truncate least-important files past the budget.
  const header =
    `# Repo map — ${index.root}\n` +
    `<!-- generated ${new Date(index.builtAt).toISOString()} · heuristic map (regex-based, not a parser) · refs are name-based, not semantic -->\n`;
  const renderFiles = (files: MapFile[]): string =>
    header + files.map(renderFileBlock).join('\n');

  let kept = mapFiles;
  let markdown = renderFiles(kept);
  let truncated = false;
  let omittedFiles = 0;
  if (estimateTokens(markdown) > maxTokens && kept.length > 0) {
    truncated = true;
    // Binary-search the largest prefix that fits (files are pre-sorted
    // by importance, so a prefix is the optimal keep-set).
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(renderFiles(kept.slice(0, mid))) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    omittedFiles = kept.length - lo;
    kept = kept.slice(0, lo);
    markdown = renderFiles(kept);
    markdown += `\n\n… truncated: ${omittedFiles} more file(s) omitted (token budget ${maxTokens})`;
  }

  const map: RepoMapData = {
    version: MAP_VERSION,
    root: index.root,
    builtAt: index.builtAt,
    files: kept,
    truncated,
    omittedFiles,
    estimatedTokens: estimateTokens(markdown),
    maxTokens,
  };
  return { map, markdown, totals };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function renderFileBlock(f: MapFile): string {
  const lines = [`\n## ${f.file}`];
  if (f.fileOnly) {
    lines.push('(no extractable symbols — file-level entry only)');
    return lines.join('\n');
  }
  for (const s of f.symbols) {
    lines.push(`- ${s.kind} ${s.name} — ${s.file}:${s.line} · refs ${s.refs} · score ${s.score.toFixed(2)}`);
    if (s.signature && s.signature !== `${s.kind} ${s.name}`) {
      lines.push(`  ${s.signature}`);
    }
  }
  return lines.join('\n');
}

/**
 * Re-render a RepoMapData as markdown (e.g. from a cached map JSON).
 * The truncation marker is reproduced from the map's own flags.
 */
export function renderMarkdown(map: RepoMapData): string {
  const header =
    `# Repo map — ${map.root}\n` +
    `<!-- generated ${new Date(map.builtAt).toISOString()} · heuristic map (regex-based, not a parser) · refs are name-based, not semantic -->\n`;
  let out = header + map.files.map(renderFileBlock).join('\n');
  if (map.truncated) {
    out += `\n\n… truncated: ${map.omittedFiles} more file(s) omitted (token budget ${map.maxTokens})`;
  }
  return out;
}
