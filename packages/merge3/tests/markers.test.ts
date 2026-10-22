/**
 * Conflict-marker parsing tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConflictMarkers, hasConflictMarkers } from '../src/index.js';
import { Merge3Error } from '../src/index.js';

const BASIC = [
  'line 1',
  '<<<<<<< HEAD',
  'ours a',
  'ours b',
  '=======',
  'theirs a',
  '>>>>>>> feature',
  'line 2',
  '<<<<<<< HEAD',
  'ours2',
  '=======',
  'theirs2',
  '>>>>>>> feature',
  'line 3',
];

test('parses two hunks with labels', () => {
  const hunks = parseConflictMarkers(BASIC);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].startLine, hunks[0].midLine, hunks[0].endLine], [1, 4, 6]);
  assert.equal(hunks[0].oursLabel, 'HEAD');
  assert.equal(hunks[0].theirsLabel, 'feature');
  assert.deepEqual(hunks[0].ours, ['ours a', 'ours b']);
  assert.deepEqual(hunks[0].theirs, ['theirs a']);
  assert.deepEqual([hunks[1].startLine, hunks[1].midLine, hunks[1].endLine], [8, 10, 12]);
  assert.equal(hunks[1].index, 1);
});

test('no markers -> empty', () => {
  assert.deepEqual(parseConflictMarkers(['a', 'b']), []);
  assert.equal(hasConflictMarkers(['a']), false);
  assert.equal(hasConflictMarkers(BASIC), true);
});

test('markers without labels get null labels', () => {
  const hunks = parseConflictMarkers(['<<<<<<<', 'o', '=======', 't', '>>>>>>>']);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oursLabel, null);
  assert.equal(hunks[0].theirsLabel, null);
});

test('unterminated hunk throws', () => {
  assert.throws(() => parseConflictMarkers(['<<<<<<<', 'o', '=======', 't'], ), (e) => {
    assert.ok(e instanceof Merge3Error);
    assert.equal((e as Merge3Error).code, 'unterminated-hunk');
    return true;
  });
});

test('nested opener throws', () => {
  assert.throws(
    () => parseConflictMarkers(['<<<<<<<', 'o', '<<<<<<<', '=======', 't', '>>>>>>>']),
    (e) => (e as Merge3Error).code === 'nested-markers',
  );
});

test('diff3-style ||||||| markers are rejected honestly', () => {
  assert.throws(
    () =>
      parseConflictMarkers([
        '<<<<<<<',
        'o',
        '||||||| base',
        'b',
        '=======',
        't',
        '>>>>>>>',
      ]),
    (e) => (e as Merge3Error).code === 'diff3-markers-unsupported',
  );
});

test('empty sides are fine', () => {
  const hunks = parseConflictMarkers(['<<<<<<<', '=======', 'theirs only', '>>>>>>>']);
  assert.deepEqual(hunks[0].ours, []);
  assert.deepEqual(hunks[0].theirs, ['theirs only']);
});
