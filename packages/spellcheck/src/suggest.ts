/**
 * Spell check (R5-A7) — Levenshtein edit-distance suggestions.
 *
 * Pure, deterministic. O(a*b) per comparison; callers bound the candidate
 * set by length so project-wide runs stay cheap.
 */

/** Classic Levenshtein distance over UTF-16 code units. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Up to `maxSuggestions` dictionary words within `maxDistance` edits of
 * `word` (lower-cased), best-first (distance, then alphabetical).
 */
export function suggest(
  word: string,
  dictionary: Iterable<string>,
  maxDistance = 2,
  maxSuggestions = 3,
): string[] {
  const w = word.toLowerCase();
  const scored: Array<{ word: string; d: number }> = [];
  for (const cand of dictionary) {
    if (cand === w) continue;
    if (Math.abs(cand.length - w.length) > maxDistance) continue;
    const d = levenshtein(w, cand);
    if (d <= maxDistance) scored.push({ word: cand, d });
  }
  scored.sort((x, y) => (x.d === y.d ? (x.word < y.word ? -1 : 1) : x.d - y.d));
  return scored.slice(0, maxSuggestions).map((s) => s.word);
}
