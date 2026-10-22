/**
 * Spell check (R5-A7) — package entry.
 *
 * Zero dependencies. Deterministic. English only (v1); the dictionary is a
 * hand-maintained subset — see dictionary.ts for the honest coverage note.
 */
export { WORDS } from './dictionary';
export { splitIdentifier, extractWords, isCheckable, tokenToWords, type WordToken } from './tokenize';
export { levenshtein, suggest } from './suggest';
export { buildDictionary, scanText } from './scan';
export { DEFAULT_SUPPRESS_MARKER, type SpellHit, type SpellScanOptions } from './types';
