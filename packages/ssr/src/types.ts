/**
 * Shared types for @ai-factory/ssr — structural search and replace.
 *
 * A "structural" node is a heuristic extraction, NOT a compiler AST:
 * the scanner is a line-oriented, zero-dependency pass in the lineage of
 * @ai-factory/codeindex's extractor (same design constraints), extended
 * with what SSR needs and codeindex lacks: visibility/static/async
 * modifiers, variable type annotations, parameter lists, and accurate
 * start..end line ranges via brace matching. TS/JS only.
 *
 * HONEST LIMITATIONS (documented, not hidden):
 *  - One line = one definition start: multi-line signatures are followed
 *    only for the parameter list (up to 20 continuation lines); exotic
 *    shapes (decorators, computed method names, object-literal methods,
 *    JSX-heavy files) are missed or misclassified.
 *  - Brace matching is string/comment/template-literal aware, but
 *    pathological nesting (regex literals containing braces, unclosed
 *    constructs) can shift an endLine. Every match carries file+line so
 *    the caller can verify in source before applying.
 *  - Rename is scope-limited (definition + whole-word hits inside the
 *    innermost enclosing body, skipping `.name` property accesses), not
 *    true scope analysis: shadowed same-name symbols in nested scopes are
 *    renamed together. The preview diff always shows exactly what changes.
 */

export type StructNodeKind =
  | 'class'
  | 'method'
  | 'function'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum';

/** One structurally-extracted definition with its source range. */
export interface StructNode {
  kind: StructNodeKind;
  /** Symbol name as written in source. */
  name: string;
  /** Path relative to the scanned root, posix-style. */
  file: string;
  /** 1-based line numbers, inclusive. */
  startLine: number;
  endLine: number;
  /** e.g. ['public','static','async','export','get']. */
  modifiers: string[];
  /** Declared type for variables (`let x: number` → "number"). */
  typeAnnotation?: string;
  /** Parameter names (best effort, see limitations). */
  params: string[];
  /** 1-based line where the snippet was taken (== startLine). */
  line: number;
  /** The definition line, trimmed, max 160 chars. */
  snippet: string;
  /** Name of the innermost enclosing class/function, if any. */
  parent?: string;
}

export interface SsrSearchSpec {
  kind?: StructNodeKind | StructNodeKind[];
  /** Regex source matched against the symbol name. */
  namePattern?: string;
  /** Every listed modifier must be present. */
  modifiers?: string[];
  /** None of these may be present. */
  modifiersAbsent?: string[];
  /** For variables: must (not) carry a declared type annotation. */
  hasTypeAnnotation?: boolean;
  /** Regex source matched against the type annotation. */
  typePattern?: string;
  minParams?: number;
  maxParams?: number;
  /** Body size in lines, inclusive. */
  minLines?: number;
  maxLines?: number;
  /** Regex source matched against the enclosing scope name. */
  enclosing?: string;
  /** Regex source matched against the root-relative file path. */
  filePattern?: string;
}

export type SsrReplaceSpec =
  | { op: 'rename'; to: string }
  | { op: 'replaceRange'; text: string }
  | { op: 'addModifier'; modifier: string };

export interface SsrTemplate {
  /** Stable id, [a-z0-9-], used in finding detail + storage. */
  id: string;
  name: string;
  description?: string;
  version: 1;
  search: SsrSearchSpec;
  replace?: SsrReplaceSpec;
  /** When true the inspection runner reports each match as a finding. */
  asInspection?: boolean;
  severity?: 'info' | 'warning' | 'error';
}

/** A template hit, ready for preview / apply / quick-fix. */
export interface SsrMatch {
  file: string;
  kind: StructNodeKind;
  name: string;
  startLine: number;
  endLine: number;
  modifiers: string[];
  snippet: string;
  parent?: string;
  templateId: string;
}

export interface FileEdit {
  file: string;
  /** 1-based inclusive range replaced. */
  startLine: number;
  endLine: number;
  /** Replacement lines. */
  newLines: string[];
  /** What the op did, for audit/preview text. */
  summary: string;
}

export interface ApplyResult {
  applied: number;
  skipped: Array<{ file: string; startLine: number; reason: string }>;
  filesChanged: string[];
  /** file → unified-style preview diff (also returned by preview). */
  diffs: Record<string, string>;
}
