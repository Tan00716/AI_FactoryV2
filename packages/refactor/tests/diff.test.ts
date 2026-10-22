import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../src/index';

describe('unifiedDiff', () => {
  it('returns empty for identical inputs', () => {
    assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  });

  it('emits git-style headers and hunks', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nline2 changed\nline3\n';
    const d = unifiedDiff(before, after, { fromFile: 'a/f.ts', toFile: 'b/f.ts' });
    assert.ok(d.startsWith('--- a/f.ts\n+++ b/f.ts\n'));
    assert.ok(d.includes('-line2\n'));
    assert.ok(d.includes('+line2 changed\n'));
    assert.ok(d.includes(' line1\n'));
    assert.ok(/^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(d));
  });

  it('is deterministic', () => {
    const d1 = unifiedDiff('a\nb\nc\n', 'a\nx\nc\n');
    const d2 = unifiedDiff('a\nb\nc\n', 'a\nx\nc\n');
    assert.equal(d1, d2);
  });

  it('handles added and removed lines', () => {
    const d = unifiedDiff('a\n', 'a\nb\nc\n');
    assert.ok(d.includes('+b\n'));
    assert.ok(d.includes('+c\n'));
    const d2 = unifiedDiff('a\nb\n', 'a\n');
    assert.ok(d2.includes('-b\n'));
  });
});
