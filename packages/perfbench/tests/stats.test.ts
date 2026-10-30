import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, percentile, summarize } from '../src/stats.js';

test('percentile uses nearest-rank', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 95), 10);
  assert.equal(percentile(v, 100), 10);
  assert.equal(percentile([], 95), 0);
});

test('mean and summarize agree on a known sample', () => {
  const v = [10, 20, 30, 40];
  assert.equal(mean(v), 25);
  const s = summarize(v);
  assert.equal(s.count, 4);
  assert.equal(s.minMs, 10);
  assert.equal(s.maxMs, 40);
  assert.equal(s.p50Ms, 20);
  assert.equal(s.p95Ms, 40);
  assert.equal(summarize([]).count, 0);
});
