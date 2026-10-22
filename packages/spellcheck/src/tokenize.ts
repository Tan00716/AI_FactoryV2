/**
 * Spell check (R5-A7) — identifier / text tokenizing.
 *
 * Pure functions, no IO. Identifier splitting follows the standard IDE
 * convention: camelCase, PascalCase, snake_case, ALLCAPS acronyms and
 * digit boundaries are all split points.
 */

/** Split one identifier into its word parts. */
export function splitIdentifier(id: string): string[] {
  const withBoundaries = id
    // lower/digit -> Upper: fooBar, v2Count
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // acronym -> Word: HTTPSConnection -> HTTPS Connection
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // separators
    .replace(/[_$]+/g, ' ')
    // letter <-> digit boundaries: base64 -> base 64
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return withBoundaries.split(/\s+/).filter(Boolean);
}

/** A raw word candidate found in a line of text. */
export interface WordToken {
  word: string;
  /** 1-based column of the token start (UTF-16 code units). */
  column: number;
}

/**
 * Extract letter-runs from a line (used for comment/string/prose text).
 * Digits act as separators so `err404msg` yields `err` and `msg`.
 */
export function extractWords(line: string): WordToken[] {
  const out: WordToken[] = [];
  const re = /[A-Za-z][A-Za-z']*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ word: m[0], column: m.index + 1 });
  }
  return out;
}

/**
 * Heuristic: should this token be spell-checked at all?
 * - length < 2: noise (single letters are usually variables).
 * - all digits: not a word.
 * - ALL-CAPS tokens longer than 1 char: treated as acronyms
 *   (DB, HTTP, MAX_PATH) — the dictionary deliberately does not try to
 *   enumerate every acronym; unknown acronyms are the documented
 *   false-negative class, not a false-positive class.
 */
export function isCheckable(raw: string, minLength: number): boolean {
  if (raw.length < minLength) return false;
  if (/^\d+$/.test(raw)) return false;
  if (raw.length > 1 && raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return false;
  return true;
}

/**
 * Normalize one raw token into the lower-cased parts to check:
 * strip a trailing possessive/contraction ("don't" -> "don","t"), split
 * the identifier, and drop single-letter fragments.
 */
export function tokenToWords(raw: string): string[] {
  const parts: string[] = [];
  for (const chunk of raw.split("'")) {
    for (const p of splitIdentifier(chunk)) {
      if (p.length > 1) parts.push(p.toLowerCase());
    }
  }
  return parts;
}
