/**
 * fuzzy.test.ts — fuzzy subsequence scoring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore } from '../src/index.js';

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    assert.equal(fuzzyScore('xyz', 'git checkout'), null);
    assert.equal(fuzzyScore('gco', 'git'), null); // longer query
  });

  it('matches case-insensitively', () => {
    assert.notEqual(fuzzyScore('GIT', 'git status'), null);
    assert.notEqual(fuzzyScore('npm', 'NPM INSTALL'), null);
  });

  it('empty query scores 0 (caller treats it as match-all)', () => {
    assert.equal(fuzzyScore('', 'anything'), 0);
  });

  it('prefers word-boundary and early matches', () => {
    const atStart = fuzzyScore('git', 'git checkout');
    const buried = fuzzyScore('git', 'xgit');
    assert.ok(atStart !== null && buried !== null && atStart > buried);
  });

  it('prefers consecutive runs', () => {
    const run = fuzzyScore('chek', 'git checkout');
    const scattered = fuzzyScore('chek', 'c-x-h-e-k');
    assert.ok(run !== null && scattered !== null && run > scattered);
  });

  it('prefers shorter targets on ties', () => {
    const short = fuzzyScore('ls', 'ls');
    const long = fuzzyScore('ls', 'ls -la /very/long/path');
    assert.ok(short !== null && long !== null && short > long);
  });
});
