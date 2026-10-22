/**
 * @ai-factory/refactor — shared types.
 *
 * Deterministic refactoring for TS/JS. Everything here is a pure function
 * of its inputs: same source in, byte-identical edits out. Zero model keys.
 */

/** The four supported refactoring operations (TS/JS first). */
export type RefactorOp =
  | 'extract-variable'
  | 'extract-method'
  | 'inline-variable'
  | 'rename';

/** One contiguous text replacement, 0-based offsets, end exclusive. */
export interface TextEdit {
  start: number;
  end: number;
  /** Replacement text (empty string = deletion). */
  text: string;
}

/** All edits for a single file. */
export interface FileEdits {
  /** Path as given by the caller (relative to the jailed root). */
  file: string;
  edits: TextEdit[];
}

export interface RefactorWarning {
  code: string;
  message: string;
}

/** One previewable, independently acceptable change (always one file). */
export interface RefactorItem {
  itemId: string;
  file: string;
  /** Human-readable title, e.g. 'Extract method `calc`'. */
  title: string;
  /** Unified diff (git-compatible) of before → after for this file. */
  diff: string;
  warnings: RefactorWarning[];
  /** Edits to apply when this item is accepted. */
  edits: TextEdit[];
  /** sha256 of the file content the analysis was based on (drift guard). */
  fileHash: string;
}

export interface RefactorProposal {
  proposalId: string;
  operation: RefactorOp;
  items: RefactorItem[];
  warnings: RefactorWarning[];
  createdAt: number;
}

export interface RefactorError {
  code: string;
  message: string;
}

export type RefactorOpResult =
  | { ok: true; fileEdits: FileEdits[]; warnings: RefactorWarning[] }
  | { ok: false; error: RefactorError };

/** Selection for extract operations. */
export interface Selection {
  /** 0-based offset, inclusive. */
  start: number;
  /** 0-based offset, exclusive. */
  end: number;
}

/** A file passed in for cross-file rename. */
export interface OtherFile {
  path: string;
  source: string;
}

export function opError(code: string, message: string): RefactorOpResult {
  return { ok: false, error: { code, message } };
}

export function opOk(
  fileEdits: FileEdits[],
  warnings: RefactorWarning[] = [],
): RefactorOpResult {
  return { ok: true, fileEdits, warnings };
}
