/**
 * Trojan Source protection (round-5 A5): detection of invisible and
 * visually-ambiguous Unicode characters — the CVE-2021-42574 attack
 * family (bidi override controls, zero-width characters, mixed-script
 * confusable identifiers).
 *
 * HONEST COVERAGE NOTE (read before relying on this):
 *   - BIDI_CONTROLS: 9 directional formatting characters
 *     (U+202A-U+202E embeds/overrides + U+2066-U+2069 isolates).
 *   - ZERO_WIDTH_CHARS: 4 characters (U+200B/U+200C/U+200D/U+FEFF).
 *     U+FEFF is only flagged when it is NOT the very first character of
 *     the file (a leading BOM is legitimate, not an attack).
 *   - CONFUSABLES: a hand-maintained SUBSET of 53 Cyrillic/Greek
 *     lookalikes of Latin letters/digits. This is NOT the full Unicode
 *     confusables table (which has thousands of entries); it covers the
 *     common attack pairs. Anything outside the table is invisible to
 *     this scanner — never claim "no confusables" from a clean result.
 *   - Confusable hits only fire inside MIXED-script word tokens (a token
 *     containing both ASCII alnum and a tabled lookalike). A pure
 *     Cyrillic or pure Greek word (legitimate non-English text) is not
 *     flagged. This is a heuristic, not a script-mixing proof.
 *   - This package only DETECTS. It never rewrites source: removing a
 *     bidi override or "fixing" a confusable can silently change program
 *     semantics, so remediation is always a human decision.
 *
 * Zero external dependencies; pure node builtins (none needed here).
 */

/** What class of suspicious character was found. */
export type TrojanKind = 'bidi-control' | 'zero-width' | 'confusable';

export type TrojanSeverity = 'error' | 'warning';

/** One suspicious character occurrence. */
export interface TrojanHit {
  kind: TrojanKind;
  /** bidi-control -> error; zero-width/confusable -> warning. */
  severity: TrojanSeverity;
  /** e.g. 'U+202E'. */
  codePoint: string;
  /** Unicode-style name, e.g. 'RIGHT-TO-LEFT OVERRIDE'. */
  name: string;
  /** For confusables: 'Cyrillic' | 'Greek'. */
  script?: string;
  /** For confusables: the Latin char it resembles, e.g. 'e'. */
  latin?: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column in UTF-16 code units (Monaco-accurate). */
  column: number;
  /** Length in UTF-16 code units. */
  length: number;
}

/** Severity by kind (deterministic, documented). */
export const TROJAN_SEVERITY: Record<TrojanKind, TrojanSeverity> = {
  'bidi-control': 'error',
  'zero-width': 'warning',
  confusable: 'warning',
};

/**
 * In-file suppression marker. Any line containing this substring
 * disables scanning for the whole file (documented escape hatch for
 * legitimate multilingual text; a scanner that cannot be silenced gets
 * disabled entirely, which is worse).
 */
export const TROJAN_SUPPRESS_MARKER = 'trojan-scan-ignore';
