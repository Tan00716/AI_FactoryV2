import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, buildDictionary, scanText } from '../src/index';

describe('dictionary', () => {
  it('declares its honest subset size', () => {
    const dict = buildDictionary(WORDS);
    // The header comment calls it "a few thousand common words plus
    // tech terms": pin the range so coverage can never silently drift.
    assert.ok(dict.size >= 2000 && dict.size <= 8000, `size ${dict.size}`);
    for (const w of ['file', 'function', 'receive', 'dictionary', 'async', 'json', 'api']) {
      assert.ok(dict.has(w), `expected '${w}' in dictionary`);
    }
  });
});
