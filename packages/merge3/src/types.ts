/**
 * R5-S3 three-way merge conflict editor — shared types.
 *
 * Honest boundary (also rendered in the UI): diff3 alignment is a
 * heuristic line alignment (Myers diff over base→ours and
 * base→theirs). It aligns cleanly for ordinary conflicts; heavily
 * restructured hunks are flagged needsManual instead of being
 * silently misaligned.
 */

/** One side of a three-way merge. */
export type MergeSide = 'ours' | 'theirs' | 'base';

/** A conflict-marker block parsed from the working file. */
export interface ConflictHunk {
  /** 0-based hunk index within the file. */
  index: number;
  /** 0-based line numbers in the working (marker) file. */
  startLine: number;
  midLine: number;
  endLine: number;
  /** Optional labels captured after the markers (may be null). */
  oursLabel: string | null;
  theirsLabel: string | null;
  ours: string[];
  theirs: string[];
}

export type Diff3ChunkKind =
  | 'stable'
  | 'ours-only'
  | 'theirs-only'
  | 'both-same'
  | 'conflict';

export interface Diff3Chunk {
  kind: Diff3ChunkKind;
  /** 1-based base line range start; -1 when the chunk has no base lines. */
  baseStart: number;
  baseLines: string[];
  oursLines: string[];
  theirsLines: string[];
  /**
   * True when the heuristic alignment looks shaky (large or
   * delete/change tangles): the UI must show "needs manual review"
   * instead of presenting the alignment as authoritative.
   */
  needsManual: boolean;
}

export interface MergeAnalysis {
  file: string;
  sha256: string;
  markerHunks: ConflictHunk[];
  stages: { base: boolean; ours: boolean; theirs: boolean };
  /** Empty when the base stage is unavailable. */
  chunks: Diff3Chunk[];
  summary: {
    markerHunks: number;
    cleanChunks: number;
    conflictChunks: number;
    needsManual: number;
  };
}

export type ResolutionChoice = 'ours' | 'theirs' | 'both' | 'custom';

export interface HunkResolution {
  /** Matches ConflictHunk.index. */
  hunk: number;
  choice: ResolutionChoice;
  /** Required (non-empty) when choice === 'custom'. */
  customText?: string;
}

export class Merge3Error extends Error {
  readonly code: string;
  constructor(message: string, code = 'merge3-error') {
    super(message);
    this.name = 'Merge3Error';
    this.code = code;
  }
}

/** Split text into lines, remembering the EOL convention + trailing newline. */
export interface SplitLines {
  lines: string[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

export function splitLines(text: string): SplitLines {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const lines = text.split(/\r\n|\n/);
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

export function joinLines(split: SplitLines, lines: string[]): string {
  const body = lines.join(split.eol);
  return split.trailingNewline ? body + split.eol : body;
}
