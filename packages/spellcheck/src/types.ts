/**
 * Spell check (R5-A7) — shared types.
 *
 * Honest scope: English words only (v1 explicitly does NOT do Chinese
 * word segmentation); the dictionary is a hand-maintained subset, not a
 * complete English lexicon — see dictionary.ts for the declared size.
 */

/** One suspected typo found in a text. */
export interface SpellHit {
  /** 1-based line number. */
  line: number;
  /** 1-based column (UTF-16 code units, like the rest of the IDE). */
  column: number;
  /** Length of the offending word in UTF-16 code units. */
  length: number;
  /** The word as written in the source (original casing). */
  word: string;
  /** Up to N closest dictionary words, best first. Empty when unknown. */
  suggestions: string[];
}

export interface SpellScanOptions {
  /** Lower-cased dictionary words. */
  dictionary: Set<string>;
  /** Extra accepted words (project dictionary), lower-cased. */
  extraWords?: Iterable<string>;
  /** Compute edit-distance suggestions (default true). The inspection
   *  checker disables this for project-wide runs (noise + cost). */
  suggest?: boolean;
  /** Minimum word length to check (default 2). */
  minLength?: number;
  /** Max suggestions per hit (default 3). */
  maxSuggestions?: number;
  /** Per-file suppression marker: when ANY line contains this marker the
   *  whole file is skipped (same semantics as the trojan checker). */
  suppressMarker?: string;
}

export const DEFAULT_SUPPRESS_MARKER = 'spell-check-ignore';
