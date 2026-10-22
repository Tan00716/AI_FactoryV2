import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitIdentifier, extractWords, isCheckable, tokenToWords } from '../src/index';

describe('splitIdentifier', () => {
  it('splits camelCase', () => {
    assert.deepEqual(splitIdentifier('fileName'), ['file', 'Name']);
  });
  it('splits PascalCase', () => {
    assert.deepEqual(splitIdentifier('SpellChecker'), ['Spell', 'Checker']);
  });
  it('splits snake_case', () => {
    assert.deepEqual(splitIdentifier('spell_checker'), ['spell', 'checker']);
  });
  it('splits acronym+word boundaries', () => {
    assert.deepEqual(splitIdentifier('HTTPSConnection'), ['HTTPS', 'Connection']);
    assert.deepEqual(splitIdentifier('parseHTTPSResponse'), ['parse', 'HTTPS', 'Response']);
  });
  it('splits digit boundaries', () => {
    assert.deepEqual(splitIdentifier('base64Encode'), ['base', '64', 'Encode']);
    assert.deepEqual(splitIdentifier('v2Count'), ['v', '2', 'Count']);
  });
  it('splits dollar separators', () => {
    assert.deepEqual(splitIdentifier('$privateVar'), ['private', 'Var']);
  });
});

describe('extractWords', () => {
  it('yields words with 1-based UTF-16 columns', () => {
    const toks = extractWords('hello world');
    assert.deepEqual(toks, [
      { word: 'hello', column: 1 },
      { word: 'world', column: 7 },
    ]);
  });
  it('splits on digits', () => {
    const toks = extractWords('err404msg');
    assert.deepEqual(toks.map((t) => t.word), ['err', 'msg']);
  });
});

describe('isCheckable', () => {
  it('skips single letters', () => assert.equal(isCheckable('x', 2), false));
  it('skips digit runs', () => assert.equal(isCheckable('404', 2), false));
  it('skips ALL-CAPS acronyms', () => {
    assert.equal(isCheckable('HTTP', 2), false);
    assert.equal(isCheckable('DB', 2), false);
  });
  it('keeps normal words', () => assert.equal(isCheckable('fiel', 2), true));
  it('respects minLength', () => assert.equal(isCheckable('an', 3), false));
});

describe('tokenToWords', () => {
  it('lowercases and drops single-letter fragments', () => {
    assert.deepEqual(tokenToWords("don't"), ['don']);
    assert.deepEqual(tokenToWords('fileName'), ['file', 'name']);
  });
});
