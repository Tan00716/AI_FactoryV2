/**
 * .env document model (round-6 task R6-A8).
 *
 * A document is a list of lines, each classified so a roundtrip edit can
 * preserve everything the editor did not touch: comments, blank lines,
 * and the exact bytes of untouched entry lines. Only lines the user
 * explicitly set or deleted are rewritten.
 */

export type DotEnvLineKind = 'blank' | 'comment' | 'entry' | 'invalid';

export interface DotEnvLine {
  kind: DotEnvLineKind;
  /** Raw line text, without the trailing newline. */
  raw: string;
  /** Entry key (entry lines only). */
  key?: string;
  /** Parsed value (entry lines only). */
  value?: string;
  /** True when the line started with the `export ` prefix. */
  exported?: boolean;
  /** Why an invalid line failed to parse (invalid lines only). */
  error?: string;
}

export interface DotEnvEntry {
  key: string;
  /** Effective value: the LAST occurrence wins, per dotenv convention. */
  value: string;
  /** Number of entry lines for this key ( > 1 means a duplicate warning). */
  occurrences: number;
}

export interface DotEnvParseResult {
  lines: DotEnvLine[];
  /** Effective entries, in first-appearance order. */
  entries: DotEnvEntry[];
  /** Parse problems (invalid lines, unclosed quotes). */
  errors: Array<{ line: number; message: string }>;
  /**
   * Line ending of the source text: '\r\n' when the file contains any
   * CRLF (Windows-style), '\n' otherwise. Serialize reuses it so a CRLF
   * file is not silently converted to LF on save (cross-platform bug
   * found by scripts/cross-platform-check.mjs, V3-#2).
   */
  lineEnding: '\n' | '\r\n';
}

/** One write operation applied by applyEnvOps (see serialize.ts). */
export type DotEnvOp =
  | { type: 'set'; key: string; value: string }
  | { type: 'delete'; key: string };
