import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuseTimeline,
  parseLogOutput,
  snapshotsToEntries,
  unifiedDiffText,
} from '../src/timeline';

const LOG = [
  'abc1234\u0001Jane Doe\u00011729500000\u0001first commit\u001e',
  'def5678\u0001John Smith\u00011729400000\u0001second commit\u001e',
].join('');

test('parses log records split by \\x1e', () => {
  const entries = parseLogOutput(LOG);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].hash, 'abc1234');
  assert.equal(entries[0].shortHash, 'abc1234');
  assert.equal(entries[0].author, 'Jane Doe');
  assert.equal(entries[0].date, 1729500000);
  assert.equal(entries[0].message, 'first commit');
  assert.equal(entries[0].kind, 'git');
});

test('fuseTimeline sorts git + snapshots newest first', () => {
  const git = parseLogOutput(LOG);
  const snaps = snapshotsToEntries([
    { id: '1729505000000-000001-save.snap', createdAt: '2026-10-21T10:30:00.000Z', kind: 'save', size: 100 },
  ]);
  const fused = fuseTimeline(git, snaps);
  assert.equal(fused.length, 3);
  // snap date 2026-10-21 > git dates 2024-10 -> snapshot first
  assert.equal(fused[0].kind, 'snapshot');
  assert.equal(fused[1].kind, 'git');
  assert.equal(fused[2].kind, 'git');
});

test('fuseTimeline with no git works (snapshots only)', () => {
  const snaps = snapshotsToEntries([
    { id: 'b.snap', createdAt: '2026-10-21T10:30:00.000Z', kind: 'save', size: 10 },
    { id: 'a.snap', createdAt: '2026-10-21T09:30:00.000Z', kind: 'save', size: 10 },
  ]);
  const fused = fuseTimeline([], snaps);
  assert.equal(fused.length, 2);
  assert.equal((fused[0] as { id: string }).id, 'b.snap');
});

test('unifiedDiffText renders changed lines with context', () => {
  const diff = unifiedDiffText('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'old', 'new');
  assert.ok(diff.startsWith('--- old\n+++ new\n'));
  assert.ok(diff.includes('-b'));
  assert.ok(diff.includes('+B'));
  assert.ok(diff.includes('@@ '));
});

test('unifiedDiffText returns empty string for identical inputs', () => {
  assert.equal(unifiedDiffText('x\ny\n', 'x\ny\n', 'old', 'new'), '');
});

test('unifiedDiffText groups distant changes into separate hunks', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const b = a.replace('line2', 'CHANGED2').replace('line25', 'CHANGED25');
  const diff = unifiedDiffText(a, b, 'old', 'new');
  const hunks = diff.split('\n').filter((l) => l.startsWith('@@ '));
  assert.equal(hunks.length, 2);
});
