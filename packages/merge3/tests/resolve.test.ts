/**
 * Resolution application tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConflictMarkers, applyResolutions } from '../src/index.js';
import { Merge3Error } from '../src/index.js';

const LINES = [
  'top',
  '<<<<<<< HEAD',
  'ours 1',
  '=======',
  'theirs 1',
  '>>>>>>> branch',
  'middle',
  '<<<<<<< HEAD',
  'ours 2a',
  'ours 2b',
  '=======',
  'theirs 2',
  '>>>>>>> branch',
  'bottom',
];

test('take ours everywhere', () => {
  const hunks = parseConflictMarkers(LINES);
  const out = applyResolutions(LINES, hunks, [
    { hunk: 0, choice: 'ours' },
    { hunk: 1, choice: 'ours' },
  ]);
  assert.deepEqual(out, ['top', 'ours 1', 'middle', 'ours 2a', 'ours 2b', 'bottom']);
});

test('mixed choices incl. both and custom', () => {
  const hunks = parseConflictMarkers(LINES);
  const out = applyResolutions(LINES, hunks, [
    { hunk: 0, choice: 'theirs' },
    { hunk: 1, choice: 'custom', customText: 'hand\nwritten' },
  ]);
  assert.deepEqual(out, ['top', 'theirs 1', 'middle', 'hand', 'written', 'bottom']);
  const out2 = applyResolutions(LINES, hunks, [
    { hunk: 0, choice: 'both' },
    { hunk: 1, choice: 'theirs' },
  ]);
  assert.deepEqual(out2, ['top', 'ours 1', 'theirs 1', 'middle', 'theirs 2', 'bottom']);
});

test('missing resolution fails closed', () => {
  const hunks = parseConflictMarkers(LINES);
  assert.throws(
    () => applyResolutions(LINES, hunks, [{ hunk: 0, choice: 'ours' }]),
    (e) => (e as Merge3Error).code === 'missing-resolution',
  );
});

test('duplicate resolution fails closed', () => {
  const hunks = parseConflictMarkers(LINES);
  assert.throws(
    () =>
      applyResolutions(LINES, hunks, [
        { hunk: 0, choice: 'ours' },
        { hunk: 0, choice: 'theirs' },
        { hunk: 1, choice: 'ours' },
      ]),
    (e) => (e as Merge3Error).code === 'duplicate-resolution',
  );
});

test('custom without text fails closed', () => {
  const hunks = parseConflictMarkers(LINES);
  assert.throws(
    () =>
      applyResolutions(LINES, hunks, [
        { hunk: 0, choice: 'custom' },
        { hunk: 1, choice: 'ours' },
      ]),
    (e) => (e as Merge3Error).code === 'custom-text-required',
  );
});

test('no hunks -> identity', () => {
  const out = applyResolutions(['a', 'b'], [], []);
  assert.deepEqual(out, ['a', 'b']);
});
