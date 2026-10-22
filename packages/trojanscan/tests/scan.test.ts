/**
 * Trojan Source scanner tests (round-5 A5).
 * node:test + node:assert/strict. Run from dist:
 *   node --test packages/trojanscan/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanText,
  scanLines,
  BIDI_CONTROLS,
  ZERO_WIDTH_CHARS,
  CONFUSABLES,
  TABLE_SIZES,
  TROJAN_SUPPRESS_MARKER,
} from '../src/index';

test('table sizes match the documented honest subset', () => {
  assert.equal(BIDI_CONTROLS.size, 9);
  assert.equal(ZERO_WIDTH_CHARS.size, 4);
  assert.equal(CONFUSABLES.size, 53);
  assert.deepEqual(TABLE_SIZES, { bidiControls: 9, zeroWidth: 4, confusables: 53 });
});

test('classic Trojan Source sample: RLO override is an error hit', () => {
  // if (access_level != "user\u202E \u2066// Check if admin\u2069\u206C") pattern, simplified
  const text = 'if (x != "admin\u202e") { grant(); } // \u2066comment\u2069';
  const hits = scanText(text);
  const kinds = hits.map((h) => h.kind);
  assert.ok(kinds.includes('bidi-control'), `expected bidi hit, got ${JSON.stringify(hits)}`);
  const rlo = hits.find((h) => h.codePoint === 'U+202E');
  assert.ok(rlo, 'expected U+202E hit');
  assert.equal(rlo.severity, 'error');
  assert.equal(rlo.name, 'RIGHT-TO-LEFT OVERRIDE');
  assert.equal(rlo.line, 1);
});

test('all 9 bidi controls are detected', () => {
  const cps = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const text = cps.map((cp) => String.fromCodePoint(cp)).join('');
  const hits = scanText(text);
  assert.equal(hits.length, 9, `expected 9 hits, got ${hits.length}`);
  assert.ok(hits.every((h) => h.kind === 'bidi-control' && h.severity === 'error'));
});

test('zero-width chars are warnings; FEFF at file start is exempt', () => {
  const withBom = '\uFEFFconst a = 1;';
  assert.equal(scanText(withBom).length, 0, 'leading BOM must not be flagged');
  const midFeff = 'const a = 1;\uFEFF\nconst b = 2;';
  const feffHit = scanText(midFeff).find((h) => h.codePoint === 'U+FEFF');
  assert.ok(feffHit, 'mid-file U+FEFF must be flagged');
  assert.equal(feffHit.severity, 'warning');
  const zwsp = scanText('let\u200bname = 1;');
  const zw = zwsp.find((h) => h.codePoint === 'U+200B');
  assert.ok(zw, 'ZWSP must be flagged');
  assert.equal(zw.kind, 'zero-width');
});

test('confusable: mixed-script identifier flagged, pure-script word not', () => {
  // 'p\u0430ssword' — Cyrillic small letter a (U+0430) inside a Latin token
  const mixed = 'const p\u0430ssword = getSecret();';
  const hits = scanText(mixed);
  const conf = hits.find((h) => h.kind === 'confusable');
  assert.ok(conf, `expected confusable hit, got ${JSON.stringify(hits)}`);
  assert.equal(conf.codePoint, 'U+0430');
  assert.equal(conf.script, 'Cyrillic');
  assert.equal(conf.latin, 'a');
  assert.equal(conf.severity, 'warning');
  // Pure Cyrillic word (legitimate non-English text) is NOT flagged.
  const pure = '// \u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440';
  assert.equal(scanText(pure).length, 0, 'pure-Cyrillic text must not be flagged');
});

test('greek confusable inside identifier is flagged', () => {
  const text = 'function \u03c1rint() {}'; // Greek rho U+03C1
  const hits = scanText(text);
  const conf = hits.find((h) => h.codePoint === 'U+03C1');
  assert.ok(conf, 'Greek rho lookalike must be flagged');
  assert.equal(conf.script, 'Greek');
  assert.equal(conf.latin, 'p');
});

test('clean ASCII source has zero hits', () => {
  const text = 'const total = items.reduce((a, b) => a + b, 0);\n// plain comment\n';
  assert.equal(scanText(text).length, 0);
});

test('suppression marker disables the whole file', () => {
  const text = `// ${TROJAN_SUPPRESS_MARKER}\nconst p\u0430ssword = 1; // \u202e`;
  assert.equal(scanText(text).length, 0, 'suppressed file must yield no hits');
});

test('line/column are 1-based UTF-16 code units', () => {
  // Emoji (surrogate pair) before the hit: column counts UTF-16 units.
  const text = 'const \u{1F600} = 1;\nlet x\u202e = 2;';
  const hits = scanText(text);
  const rlo = hits.find((h) => h.codePoint === 'U+202E');
  assert.ok(rlo);
  assert.equal(rlo.line, 2);
  assert.equal(rlo.column, 6, `expected column 6, got ${rlo.column}`);
  assert.equal(rlo.length, 1);
});

test('scanLines entry point matches scanText', () => {
  const lines = ['const a = 1;', 'let x\u200c = 2;'];
  const a = scanText(lines.join('\n'));
  const b = scanLines(lines);
  assert.deepEqual(a, b);
});

test('hits are sorted by (line, column)', () => {
  const text = 'b\u202ea\u200d';
  const hits = scanText(text);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].column < hits[1].column);
});
