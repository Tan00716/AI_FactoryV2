/**
 * The `.code-search` file format — a saveable, shareable, re-runnable
 * search document.
 *
 * Layout (deterministic, plain UTF-8 text):
 *
 *   // === ai-factory code-search v1 ===
 *   // query: TODO
 *   // regex: false
 *   // caseSensitive: false
 *   // glob: src/**
 *   // root: .
 *   // ranAt: 2026-10-22T18:30:00.000+08:00
 *   // files: 2  matches: 5  truncated: false
 *   // note: results are a snapshot; file changes require a re-run
 *   // === results ===
 *   <blank>
 *   src/a.ts (3 matches)
 *     12:1  matched line text
 *   <blank>
 *   src/b.ts (2 matches)
 *     7:5  matched line text
 *
 * The header is the editable query block: changing it and pressing
 * "re-run" re-executes the search and replaces the body. The body is
 * rendered read-only in the UI (click a row to jump to the file).
 * `parseCodeSearchFile` recovers the query for re-run; it tolerates
 * hand edits but fails closed on a corrupt header (never guesses).
 */

import {
  CodeSearchError,
  CodeSearchFileGroup,
  CodeSearchMatch,
  CodeSearchResult,
  NormalizedCodeSearchQuery,
} from './types.js';

export const CODE_SEARCH_MAGIC = '// === ai-factory code-search v1 ===';
export const CODE_SEARCH_RESULTS_SEP = '// === results ===';
export const CODE_SEARCH_SNAPSHOT_NOTE =
  'results are a snapshot; file changes require a re-run';

export interface CodeSearchFileHeader extends NormalizedCodeSearchQuery {
  /** Workspace-relative root the search ran against ('.' default). */
  root: string;
  /** ISO timestamp of the run, informational only. */
  ranAt: string;
  files: number;
  matches: number;
  truncated: boolean;
}

export interface ParsedCodeSearchFile {
  header: CodeSearchFileHeader;
  groups: CodeSearchFileGroup[];
}

function headerLine(key: string, value: string): string {
  return `// ${key}: ${value}`;
}

/** Serialize a finished search into a `.code-search` document. */
export function serializeCodeSearchFile(
  root: string,
  result: CodeSearchResult,
  ranAt?: string,
): string {
  const q = result.query;
  const lines: string[] = [
    CODE_SEARCH_MAGIC,
    headerLine('query', q.query),
    headerLine('regex', String(q.regex)),
    headerLine('caseSensitive', String(q.caseSensitive)),
    headerLine('glob', q.globs.join(', ')),
    headerLine('root', root && root.length > 0 ? root : '.'),
    headerLine('ranAt', ranAt ?? new Date().toISOString()),
    headerLine(
      'files',
      `${result.groups.length}  matches: ${result.totalMatches}  truncated: ${result.stats.truncated}`,
    ),
    headerLine('note', CODE_SEARCH_SNAPSHOT_NOTE),
    CODE_SEARCH_RESULTS_SEP,
    '',
  ];
  for (const g of result.groups) {
    lines.push(`${g.file} (${g.matches.length} ${g.matches.length === 1 ? 'match' : 'matches'})`);
    for (const m of g.matches) {
      lines.push(`  ${m.line}:${m.column}  ${m.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseHeader(lines: string[]): CodeSearchFileHeader {
  const kv = new Map<string, string>();
  for (const ln of lines) {
    const m = /^\/\/ ([A-Za-z]+): ?(.*)$/.exec(ln);
    if (m) kv.set(m[1], m[2] ?? '');
  }
  const req = (k: string): string => {
    const v = kv.get(k);
    if (v === undefined) throw new CodeSearchError(`code-search header is missing "${k}"`);
    return v;
  };
  const bool = (k: string): boolean => {
    const v = req(k).trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new CodeSearchError(`code-search header "${k}" must be true/false`);
  };
  const filesLine = req('files');
  const fm = /^(\d+)\s+matches:\s*(\d+)\s+truncated:\s*(true|false)$/.exec(filesLine.trim());
  if (!fm) throw new CodeSearchError('code-search header "files" line is corrupt');
  return {
    query: req('query'),
    regex: bool('regex'),
    caseSensitive: bool('caseSensitive'),
    globs: (kv.get('glob') ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g.length > 0),
    maxMatches: 2000,
    root: req('root').trim() || '.',
    ranAt: req('ranAt'),
    files: Number(fm[1]),
    matches: Number(fm[2]),
    truncated: fm[3] === 'true',
  };
}

/**
 * Parse a `.code-search` document back into its header + result groups.
 * The body is informational (a re-run regenerates it); the header is
 * validated fail-closed.
 */
export function parseCodeSearchFile(text: string): ParsedCodeSearchFile {
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== CODE_SEARCH_MAGIC) {
    throw new CodeSearchError('not a .code-search file (magic header missing)');
  }
  const sepIdx = lines.findIndex((l) => l.trim() === CODE_SEARCH_RESULTS_SEP);
  if (sepIdx < 0) throw new CodeSearchError('code-search file has no results separator');
  const header = parseHeader(lines.slice(1, sepIdx));
  const groups: CodeSearchFileGroup[] = [];
  let cur: CodeSearchFileGroup | null = null;
  const groupRe = /^(.*) \((\d+) (matches|match)\)$/;
  const rowRe = /^  (\d+):(\d+)  (.*)$/;
  for (const ln of lines.slice(sepIdx + 1)) {
    if (ln.trim() === '') {
      cur = null;
      continue;
    }
    const gm = groupRe.exec(ln);
    if (gm && !ln.startsWith(' ')) {
      cur = { file: gm[1], matches: [] };
      groups.push(cur);
      continue;
    }
    const rm = rowRe.exec(ln);
    if (rm && cur) {
      const match: CodeSearchMatch = {
        file: cur.file,
        line: Number(rm[1]),
        column: Number(rm[2]),
        text: rm[3],
      };
      cur.matches.push(match);
      continue;
    }
    throw new CodeSearchError(`code-search body is corrupt near: ${ln.slice(0, 60)}`);
  }
  return { header, groups };
}
