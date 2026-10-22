/**
 * Spell check (R5-A7) — the deterministic scanner.
 *
 * v1 policy (documented, uniform across identifiers/comments/strings):
 * - identifier words are split (camelCase/snake_case/digits) then checked;
 * - single letters, all-digit runs and ALL-CAPS acronyms are skipped;
 * - per-file suppression when any line contains the suppress marker;
 * - only flags, never rewrites.
 */
import { DEFAULT_SUPPRESS_MARKER, type SpellHit, type SpellScanOptions } from './types';
import { extractWords, isCheckable, tokenToWords } from './tokenize';
import { suggest } from './suggest';

/** Lower-cased, de-duplicated dictionary words (the declared subset). */
export function buildDictionary(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    const t = w.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

export function scanText(text: string, opts: SpellScanOptions): SpellHit[] {
  const minLength = opts.minLength ?? 2;
  const maxSuggestions = opts.maxSuggestions ?? 3;
  const doSuggest = opts.suggest ?? true;
  const marker = opts.suppressMarker ?? DEFAULT_SUPPRESS_MARKER;

  const dict = new Set<string>(opts.dictionary);
  if (opts.extraWords) {
    for (const w of opts.extraWords) {
      const t = String(w).trim().toLowerCase();
      if (t) dict.add(t);
    }
  }

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes(marker)) return [];
  }

  const hits: SpellHit[] = [];
  lines.forEach((line, i) => {
    for (const tok of extractWords(line)) {
      if (!isCheckable(tok.word, minLength)) continue;
      for (const part of tokenToWords(tok.word)) {
        if (part.length < minLength) continue;
        if (dict.has(part)) continue;
        hits.push({
          line: i + 1,
          column: tok.column,
          length: tok.word.length,
          word: tok.word,
          suggestions: doSuggest ? suggest(part, dict, 2, maxSuggestions) : [],
        });
        break; // one hit per token; the first bad part wins
      }
    }
  });
  return hits;
}
