/**
 * Command palette matching unit tests.
 * node:test + node:assert/strict. Run: node --test apps/desktop/tests/unit/cmdk.test.mjs
 * (also runs as phase 1 of `npm run test:desktop`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fuzzyScore, rankMatches, flattenAgents } = await import('../../src/utils/cmdk.ts');

test('empty query scores 0 (matches everything)', () => {
  assert.equal(fuzzyScore('', 'Git'), 0);
  assert.equal(fuzzyScore('   ', 'Git'), 0);
});

test('case-insensitive subsequence match', () => {
  assert.ok(fuzzyScore('git', 'Git') !== null);
  assert.ok(fuzzyScore('GIT', 'git panel') !== null);
});

test('returns null when characters are missing or out of order', () => {
  assert.equal(fuzzyScore('xyz', 'Git'), null);
  assert.equal(fuzzyScore('tg', 'Git'), null); // t before g not present in order
  assert.equal(fuzzyScore('gitt', 'Git'), null);
});

test('prefix match outranks scattered match', () => {
  const a = fuzzyScore('git', 'Git');
  const b = fuzzyScore('git', 'Getting it together');
  assert.ok(a !== null && b !== null && a > b, `prefix ${a} should beat scattered ${b}`);
});

test('word-boundary match outranks mid-word match', () => {
  const a = fuzzyScore('plan', 'Plan mode');
  const b = fuzzyScore('plan', 'Explain things');
  assert.ok(a !== null && b !== null && a > b, `boundary ${a} should beat mid-word ${b}`);
});

test('consecutive run outranks gapped match', () => {
  const a = fuzzyScore('abc', 'abc');
  const b = fuzzyScore('abc', 'aXbXc');
  assert.ok(a !== null && b !== null && a > b, `consecutive ${a} should beat gapped ${b}`);
});

test('rankMatches returns best-first indices, dropping non-matches', () => {
  const order = rankMatches('git', ['Git', 'Merges', 'Getting it', 'Plugins']);
  assert.deepEqual(order[0], 0);
  assert.ok(!order.includes(1), 'non-matching candidate dropped');
  assert.ok(order.length >= 2, 'scattered match still included');
});

test('rankMatches empty query keeps original order', () => {
  assert.deepEqual(rankMatches('', ['b', 'a', 'c']), [0, 1, 2]);
});

test('flattenAgents walks the org tree', () => {
  const org = [
    {
      agent: { id: 'a1', displayName: 'Alice', jobTitle: 'Dev' },
      children: [
        { agent: { id: 'a2', displayName: 'Bob', jobTitle: 'QA' }, children: [] },
      ],
    },
    { agent: { id: 'a3', displayName: 'Cara', jobTitle: '' }, children: [] },
  ];
  const flat = flattenAgents(org);
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map((a) => a.id), ['a1', 'a2', 'a3']);
  assert.equal(flat[1].displayName, 'Bob');
});
