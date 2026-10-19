/**
 * Shared types for @ai-factory/codeindex.
 *
 * A code index maps a repository root to two structures:
 *   1. symbols — heuristic-extracted definitions (functions, classes,
 *      exports) with file + line locations;
 *   2. inverted — token → postings (file, line) for full-text search.
 *
 * Everything is relative to the indexed root; the on-disk format is
 * plain JSON so it stays inspectable and debuggable.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'export';

export interface CodeSymbol {
  /** Symbol name as written in source. */
  name: string;
  kind: SymbolKind;
  /** Path relative to the indexed root, posix-style. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The source line the symbol was extracted from (trimmed). */
  snippet: string;
}

export interface FileRecord {
  /** Path relative to the indexed root, posix-style. */
  rel: string;
  /** mtime in ms at index time (incremental-update watermark). */
  mtimeMs: number;
  /** Byte size at index time. */
  size: number;
  symbols: CodeSymbol[];
  /** token → first 1-based line it appears on (reused on incremental builds). */
  tokens: Record<string, number>;
}

/** Postings are [fileIndex, line] pairs; fileIndex indexes `files`. */
export type Posting = [number, number];

export interface IndexData {
  version: 1;
  /** Absolute, realpath-resolved root this index was built from. */
  root: string;
  builtAt: number;
  files: FileRecord[];
  symbols: CodeSymbol[];
  /** token (lowercase) → postings, capped per token. */
  inverted: Record<string, Posting[]>;
}

export interface SearchHit {
  file: string;
  line: number;
  snippet: string;
  /** For symbol search: the matched symbol name/kind. */
  symbol?: string;
  kind?: SymbolKind;
  /** For text search: number of matching token occurrences. */
  score?: number;
  /** Optional attached source context (see withContext). */
  context?: string;
}

export interface IndexStats {
  root: string;
  files: number;
  symbols: number;
  tokens: number;
  bytes: number;
  builtAt: number;
  /** True when every file was rebuilt (no incremental shortcut). */
  full: boolean;
}
