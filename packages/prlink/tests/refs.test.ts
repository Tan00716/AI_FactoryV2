import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReferences, mergeReferences, validateNumber, validateRepoSlug } from '../src/refs';
import { PrLinkError } from '../src/types';

test('bare and repo forms, dedup, first-seen order', () => {
  const refs = extractReferences('fix(auth): close #42 and owner/repo#7, again #42', 'message');
  assert.deepEqual(
    refs.map((r) => `${r.repo ?? ''}#${r.number}`),
    ['#42', 'owner/repo#7'],
  );
});

test('repo span does not double-count its bare tail', () => {
  const refs = extractReferences('branch owner/repo#9', 'branch');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.repo, 'owner/repo');
  assert.equal(refs[0]?.number, 9);
});

test('bare numbers without # are ignored', () => {
  assert.deepEqual(extractReferences('fixes 123 and PR-456', 'message'), []);
});

test('mergeReferences dedups across lists', () => {
  const merged = mergeReferences([
    [{ number: 1, source: 'branch' }],
    [
      { number: 1, source: 'message' },
      { number: 2, repo: 'a/b', source: 'message' },
    ],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.source, 'branch');
});

test('validators reject bad slugs and numbers', () => {
  assert.throws(() => validateRepoSlug('not-a-slug'), PrLinkError);
  assert.throws(() => validateRepoSlug('a/b/c'), PrLinkError);
  assert.throws(() => validateNumber(0), PrLinkError);
  assert.throws(() => validateNumber(1.5), PrLinkError);
  validateRepoSlug('owner-name/repo.name_1');
  validateNumber(123);
});
