import type { SymbolKind } from '@ai-factory/codeindex';

/** One definition in the map, with its heuristic importance score. */
export interface MapSymbol {
  /** Symbol name as written in source. */
  name: string;
  kind: SymbolKind;
  /** Path relative to the indexed root, posix-style. */
  file: string;
  /** 1-based line number of the definition. */
  line: number;
  /** The full definition line (trimmed, ≤160 chars) — the "signature". */
  signature: string;
  /**
   * Heuristic reference count: number of *other files* whose token set
   * contains this symbol's name. Name-based, not semantic — see the
   * package header for the honest limitations.
   */
  refs: number;
  /** Importance score (higher = more central). Deterministic. */
  score: number;
}

/** One file in the map. */
export interface MapFile {
  /** Path relative to the indexed root, posix-style. */
  file: string;
  /** Sum of the file's symbol scores (0 for symbol-less files). */
  score: number;
  symbols: MapSymbol[];
  /** True when the file has no extractable symbols (other languages). */
  fileOnly: boolean;
}

export interface RepoMapData {
  version: 1;
  /** Absolute, realpath-resolved root this map was built from. */
  root: string;
  builtAt: number;
  files: MapFile[];
  /** True when the token budget cut files off the rendered map. */
  truncated: boolean;
  /** Number of files omitted by the budget cut (0 when not truncated). */
  omittedFiles: number;
  /** Estimated tokens of the rendered markdown (chars/4 estimator). */
  estimatedTokens: number;
  /** The maxTokens budget this render was built under. */
  maxTokens: number;
}

export interface RepoMapStats {
  root: string;
  files: number;
  symbols: number;
  /** Sum of refs over all symbols. */
  totalRefs: number;
  truncated: boolean;
  omittedFiles: number;
  estimatedTokens: number;
  /** True when the underlying codeindex build reused every file. */
  incremental: boolean;
  builtAt: number;
  ms: number;
}

export interface BuildMapOptions {
  /**
   * Token budget for the rendered markdown. Files are dropped
   * least-important-first past the budget; the cut is explicitly
   * marked. Default 20000.
   */
  maxTokens?: number;
  /** Skip the incremental shortcut and re-walk everything. */
  full?: boolean;
}
