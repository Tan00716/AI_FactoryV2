/**
 * Snippet library — shared types.
 *
 * A snippet is a pure-text template: expanding it NEVER executes code, runs a
 * command, or touches the network. Expansion happens inside the editor only.
 *
 * Template grammar (Monaco-compatible subset, deterministic):
 *   $1, $2, ...          tab stops (jump order 1,2,...; $0 = final cursor)
 *   ${1:default}          placeholder with default text
 *   ${NAME}              built-in variable (FILENAME, DATE, TIME) — uppercase
 *   \$                   literal dollar sign
 *
 * Honest boundary: nested placeholders such as `${1:${2:x}}` are NOT
 * supported; the validator rejects them fail-closed.
 */

/** One snippet definition as stored in .ai-factory/snippets.json. */
export interface SnippetDef {
  /** Stable id, unique within the file. Lowercase alnum/dash/underscore. */
  id: string;
  /** The word the user types before pressing Tab. */
  trigger: string;
  /** Human description (used in the completion list). */
  description?: string;
  /** Language scopes this snippet applies to; '*' matches everything. */
  scope: string[];
  /** Template body in the grammar above. */
  body: string;
}

/** A contributor of snippet sets (builtin defaults, plugin providers). */
export interface SnippetProvider {
  /** Unique provider id, e.g. 'builtin' or 'plugin:my-plugin'. */
  id: string;
  getSnippets(): SnippetDef[];
}

/** A parsed segment of a template body. */
export type TemplateSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tabstop'; index: number }
  | { kind: 'placeholder'; index: number; defaultText: string }
  | { kind: 'variable'; name: string };

/** Result of expanding a template with variables substituted. */
export interface ExpandedSnippet {
  /** Body text with variables substituted; tab stops preserved as $n. */
  text: string;
  /** Tab-stop indices in jump order ($1..$n, then $0). */
  tabOrder: number[];
  /** Max placeholder default length used for preview. */
  preview: string;
}

export const MAX_SNIPPET_BODY_BYTES = 32 * 1024;
export const MAX_SNIPPETS_PER_FILE = 1000;
export const MAX_PLACEHOLDER_INDEX = 99;

export const BUILTIN_VARIABLES = ['FILENAME', 'DATE', 'TIME'] as const;
