import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRepo } from '../src/tasks.ts';

test('searchRepo reports skipped when the root yields no files', () => {
  const r = searchRepo('/nonexistent-perfbench-root-xyz', 'test');
  assert.equal(r.task, 'search-test');
  assert.equal(r.skipped, true);
  assert.match(r.skipReason ?? '', /no files scanned/);
});
