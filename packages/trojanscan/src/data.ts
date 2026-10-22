/**
 * Static character tables for the Trojan Source scanner.
 * Zero dependencies; hand-maintained subsets (see types.ts for the
 * honest coverage note).
 */

/** Bidirectional formatting controls: code point -> Unicode name. */
export const BIDI_CONTROLS: ReadonlyMap<number, string> = new Map([
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
]);

/** Zero-width / invisible characters: code point -> Unicode name. */
export const ZERO_WIDTH_CHARS: ReadonlyMap<number, string> = new Map([
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
]);

export interface ConfusableEntry {
  /** The non-Latin code point. */
  cp: number;
  /** The Latin char it visually resembles. */
  latin: string;
  /** 'Cyrillic' | 'Greek'. */
  script: string;
  /** Unicode-style name of the non-Latin char. */
  name: string;
}

// Hand-maintained SUBSET: common Cyrillic/Greek lookalikes of Latin
// letters/digits. Not the full Unicode confusables table.
const CONFUSABLE_ROWS: ReadonlyArray<[number, string, string, string]> = [
  // Cyrillic lowercase
  [0x0430, 'a', 'Cyrillic', 'CYRILLIC SMALL LETTER A'],
  [0x0435, 'e', 'Cyrillic', 'CYRILLIC SMALL LETTER IE'],
  [0x043e, 'o', 'Cyrillic', 'CYRILLIC SMALL LETTER O'],
  [0x0440, 'p', 'Cyrillic', 'CYRILLIC SMALL LETTER ER'],
  [0x0441, 'c', 'Cyrillic', 'CYRILLIC SMALL LETTER ES'],
  [0x0445, 'x', 'Cyrillic', 'CYRILLIC SMALL LETTER HA'],
  [0x0443, 'y', 'Cyrillic', 'CYRILLIC SMALL LETTER U'],
  [0x043a, 'k', 'Cyrillic', 'CYRILLIC SMALL LETTER KA'],
  [0x043c, 'm', 'Cyrillic', 'CYRILLIC SMALL LETTER EM'],
  [0x043d, 'h', 'Cyrillic', 'CYRILLIC SMALL LETTER EN'],
  [0x0442, 't', 'Cyrillic', 'CYRILLIC SMALL LETTER TE'],
  [0x0432, 'b', 'Cyrillic', 'CYRILLIC SMALL LETTER VE'],
  [0x0456, 'i', 'Cyrillic', 'CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I'],
  [0x0458, 'j', 'Cyrillic', 'CYRILLIC SMALL LETTER JE'],
  [0x0455, 's', 'Cyrillic', 'CYRILLIC SMALL LETTER DZE'],
  [0x0437, '3', 'Cyrillic', 'CYRILLIC SMALL LETTER ZE'],
  // Cyrillic uppercase
  [0x0410, 'A', 'Cyrillic', 'CYRILLIC CAPITAL LETTER A'],
  [0x0412, 'B', 'Cyrillic', 'CYRILLIC CAPITAL LETTER VE'],
  [0x0421, 'C', 'Cyrillic', 'CYRILLIC CAPITAL LETTER ES'],
  [0x0415, 'E', 'Cyrillic', 'CYRILLIC CAPITAL LETTER IE'],
  [0x041d, 'H', 'Cyrillic', 'CYRILLIC CAPITAL LETTER EN'],
  [0x041a, 'K', 'Cyrillic', 'CYRILLIC CAPITAL LETTER KA'],
  [0x041c, 'M', 'Cyrillic', 'CYRILLIC CAPITAL LETTER EM'],
  [0x041e, 'O', 'Cyrillic', 'CYRILLIC CAPITAL LETTER O'],
  [0x0420, 'P', 'Cyrillic', 'CYRILLIC CAPITAL LETTER ER'],
  [0x0422, 'T', 'Cyrillic', 'CYRILLIC CAPITAL LETTER TE'],
  [0x0425, 'X', 'Cyrillic', 'CYRILLIC CAPITAL LETTER HA'],
  // Greek lowercase
  [0x03b1, 'a', 'Greek', 'GREEK SMALL LETTER ALPHA'],
  [0x03b5, 'e', 'Greek', 'GREEK SMALL LETTER EPSILON'],
  [0x03b9, 'i', 'Greek', 'GREEK SMALL LETTER IOTA'],
  [0x03ba, 'k', 'Greek', 'GREEK SMALL LETTER KAPPA'],
  [0x03bd, 'v', 'Greek', 'GREEK SMALL LETTER NU'],
  [0x03bf, 'o', 'Greek', 'GREEK SMALL LETTER OMICRON'],
  [0x03c1, 'p', 'Greek', 'GREEK SMALL LETTER RHO'],
  [0x03c4, 't', 'Greek', 'GREEK SMALL LETTER TAU'],
  [0x03c7, 'x', 'Greek', 'GREEK SMALL LETTER CHI'],
  [0x03b7, 'n', 'Greek', 'GREEK SMALL LETTER ETA'],
  [0x03bc, 'u', 'Greek', 'GREEK SMALL LETTER MU'],
  [0x03c9, 'w', 'Greek', 'GREEK SMALL LETTER OMEGA'],
  [0x03c2, 's', 'Greek', 'GREEK SMALL LETTER FINAL SIGMA'],
  // Greek uppercase
  [0x0391, 'A', 'Greek', 'GREEK CAPITAL LETTER ALPHA'],
  [0x0392, 'B', 'Greek', 'GREEK CAPITAL LETTER BETA'],
  [0x0395, 'E', 'Greek', 'GREEK CAPITAL LETTER EPSILON'],
  [0x0397, 'H', 'Greek', 'GREEK CAPITAL LETTER ETA'],
  [0x0399, 'I', 'Greek', 'GREEK CAPITAL LETTER IOTA'],
  [0x039a, 'K', 'Greek', 'GREEK CAPITAL LETTER KAPPA'],
  [0x039c, 'M', 'Greek', 'GREEK CAPITAL LETTER MU'],
  [0x039d, 'N', 'Greek', 'GREEK CAPITAL LETTER NU'],
  [0x039f, 'O', 'Greek', 'GREEK CAPITAL LETTER OMICRON'],
  [0x03a1, 'P', 'Greek', 'GREEK CAPITAL LETTER RHO'],
  [0x03a4, 'T', 'Greek', 'GREEK CAPITAL LETTER TAU'],
  [0x03a7, 'X', 'Greek', 'GREEK CAPITAL LETTER CHI'],
  [0x0396, 'Z', 'Greek', 'GREEK CAPITAL LETTER ZETA'],
];

/** Non-Latin code point -> confusable entry. */
export const CONFUSABLES: ReadonlyMap<number, ConfusableEntry> = new Map(
  CONFUSABLE_ROWS.map(([cp, latin, script, name]) => [cp, { cp, latin, script, name }]),
);

/** Honest table sizes for docs/UI (never claim full-Unicode coverage). */
export const TABLE_SIZES = {
  bidiControls: BIDI_CONTROLS.size,
  zeroWidth: ZERO_WIDTH_CHARS.size,
  confusables: CONFUSABLES.size,
} as const;
