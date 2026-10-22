/**
 * diff3 alignment tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff3 } from '../src/index.js';

test('no changes -> single stable chunk', () => {
  const chunks = diff3(['a', 'b'], ['a', 'b'], ['a', 'b']);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'stable');
  assert.equal(chunks[0].needsManual, false);
});

test('ours-only change', () => {
  const chunks = diff3(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'c']);
  const kinds = chunks.map((c) => c.kind);
  assert.deepEqual(kinds, ['stable', 'ours-only', 'stable']);
  assert.deepEqual(chunks[1].oursLines, ['B']);
  assert.deepEqual(chunks[1].theirsLines, ['b']);
});

test('theirs-only change', () => {
  const chunks = diff3(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'C']);
  const kinds = chunks.map((c) => c.kind);
  assert.deepEqual(kinds, ['stable', 'theirs-only']);
});

test('identical change on both sides -> both-same', () => {
  const chunks = diff3(['a', 'b'], ['a', 'B'], ['a', 'B']);
  assert.ok(chunks.some((c) => c.kind === 'both-same'));
  assert.ok(!chunks.some((c) => c.kind === 'conflict'));
});

test('divergent change -> conflict, small, no needsManual', () => {
  const chunks = diff3(['a', 'b', 'c'], ['a', 'B1', 'c'], ['a', 'B2', 'c']);
  const conflict = chunks.find((c) => c.kind === 'conflict');
  assert.ok(conflict);
  assert.deepEqual(conflict.oursLines, ['B1']);
  assert.deepEqual(conflict.theirsLines, ['B2']);
  assert.deepEqual(conflict.baseLines, ['b']);
  assert.equal(conflict.needsManual, false);
});

test('large conflict -> needsManual', () => {
  const base = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const ours = [...base];
  ours.splice(5, 35, ...Array.from({ length: 35 }, (_, i) => `ours ${i}`));
  const theirs = [...base];
  theirs.splice(5, 35, ...Array.from({ length: 35 }, (_, i) => `theirs ${i}`));
  const chunks = diff3(base, ours, theirs);
  const conflict = chunks.find((c) => c.kind === 'conflict');
  assert.ok(conflict);
  assert.equal(conflict.needsManual, true);
});

test('delete-vs-change tangle -> needsManual', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  const ours = ['a', 'e']; // deleted b,c,d
  const theirs = ['a', 'B', 'C', 'D', 'e']; // changed b,c,d
  const chunks = diff3(base, ours, theirs);
  const conflict = chunks.find((c) => c.kind === 'conflict');
  assert.ok(conflict);
  assert.equal(conflict.needsManual, true);
});

test('append at EOF on both sides differently -> conflict', () => {
  const chunks = diff3(['a'], ['a', 'o1'], ['a', 't1']);
  const conflict = chunks.find((c) => c.kind === 'conflict');
  assert.ok(conflict);
  assert.deepEqual(conflict.baseLines, []);
  assert.deepEqual(conflict.oursLines, ['o1']);
  assert.deepEqual(conflict.theirsLines, ['t1']);
});

test('append at EOF on one side -> theirs-only/ours-only', () => {
  const chunks = diff3(['a'], ['a'], ['a', 't1']);
  assert.ok(chunks.some((c) => c.kind === 'theirs-only'));
  assert.ok(!chunks.some((c) => c.kind === 'conflict'));
});

test('auto-merge reconstruction: stable+ours-only+theirs-only+both-same', () => {
  const base = ['1', '2', '3', '4', '5'];
  const ours = ['1', 'two', '3', '4', '5'];
  const theirs = ['1', '2', '3', 'four', '5'];
  const chunks = diff3(base, ours, theirs);
  const merged: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'stable' || c.kind === 'both-same') merged.push(...c.baseLines);
    else if (c.kind === 'ours-only') merged.push(...c.oursLines);
    else if (c.kind === 'theirs-only') merged.push(...c.theirsLines);
    else throw new Error('unexpected conflict');
  }
  assert.deepEqual(merged, ['1', 'two', '3', 'four', '5']);
});
