import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, buildDictionary, scanText } from '../src/index';

const dict = () => buildDictionary(WORDS);

describe('scanText', () => {
  it('flags a misspelled word with line/column', () => {
    const hits = scanText('const recieve = 1;\n', { dictionary: dict() });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
    assert.equal(hits[0].column, 7);
    assert.equal(hits[0].word, 'recieve');
    assert.ok(hits[0].suggestions.includes('receive'), `suggestions: ${hits[0].suggestions}`);
  });
  it('accepts clean text', () => {
    const hits = scanText('function receiveFile(fileName) {\n  return fileName;\n}\n', { dictionary: dict() });
    assert.deepEqual(hits, []);
  });
  it('checks comments and strings too (uniform v1 policy)', () => {
    const hits = scanText('// recieve the package\nconst ok = "seperator";\n', { dictionary: dict() });
    const words = hits.map((h) => h.word);
    assert.ok(words.includes('recieve'), words.join(','));
    assert.ok(words.includes('seperator'), words.join(','));
  });
  it('skips acronyms and single letters', () => {
    const hits = scanText('const HTTP = 1; const x = DB.query();\n', { dictionary: dict() });
    assert.deepEqual(hits, []);
  });
  it('skips digit-only tokens', () => {
    const hits = scanText('const port = 8080;\n', { dictionary: dict() });
    assert.deepEqual(hits, []);
  });
  it('honors extraWords (project dictionary)', () => {
    const text = 'const tanboon = 1;\n';
    assert.equal(scanText(text, { dictionary: dict() }).length, 1);
    assert.equal(scanText(text, { dictionary: dict(), extraWords: ['tanboon'] }).length, 0);
  });
  it('whole-file suppression on the marker', () => {
    const text = '// spell-check-ignore\nconst fielName = 1;\n';
    assert.deepEqual(scanText(text, { dictionary: dict() }), []);
  });
  it('can disable suggestions', () => {
    const hits = scanText('const fielName = 1;\n', { dictionary: dict(), suggest: false });
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].suggestions, []);
  });
  it('splits camelCase inside identifiers before checking', () => {
    // 'fielName' -> parts 'fiel' + 'name'; 'fiel' is flagged, suggestions
    // come from the edit-distance engine (feel/field/fill are all distance 1).
    const hits = scanText('fielName\n', { dictionary: dict() });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].word, 'fielName');
    assert.ok(hits[0].suggestions.length > 0, 'expected suggestions');
  });
  it('ignores non-Latin script runs (English-only v1)', () => {
    // Cyrillic text is not even tokenized by extractWords — the v1 scope
    // is Latin-script English only, documented in types.ts.
    const hits = scanText('// привет мир\nconst greeting = 1;\n', { dictionary: dict() });
    assert.deepEqual(hits, []);
  });
});

describe('levenshtein suggestions (via scanText)', () => {
  it('suggests receive for recieve', () => {
    const hits = scanText('recieve\n', { dictionary: dict() });
    // distance-2 ties break alphabetically: believe < receive < recipe.
    assert.ok(hits[0].suggestions.includes('receive'), hits[0].suggestions.join(','));
  });
  it('suggests separate for seperate', () => {
    const hits = scanText('seperate\n', { dictionary: dict() });
    assert.ok(hits[0].suggestions.includes('separate'), hits[0].suggestions.join(','));
  });
});
