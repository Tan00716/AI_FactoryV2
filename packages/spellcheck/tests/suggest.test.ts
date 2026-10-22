import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, suggest } from '../src/index';

describe('levenshtein', () => {
  it('identical strings', () => assert.equal(levenshtein('file', 'file'), 0));
  it('single substitution', () => assert.equal(levenshtein('fiel', 'file'), 2));
  it('empty strings', () => assert.equal(levenshtein('', 'abc'), 3));
});

describe('suggest', () => {
  const dict = ['file', 'field', 'fill', 'fire', 'function'];
  it('returns closest first; ties break alphabetically', () => {
    // 'fiel'->'file' and 'fiel'->'field' are both distance 2.
    const s = suggest('fiel', dict);
    assert.equal(s[0], 'field');
    assert.ok(s.includes('file'));
  });
  it('returns nothing beyond maxDistance', () => {
    assert.deepEqual(suggest('xyzzy', dict), []);
  });
  it('caps the count', () => {
    const s = suggest('fiel', dict, 3, 1);
    assert.equal(s.length, 1);
  });
});
