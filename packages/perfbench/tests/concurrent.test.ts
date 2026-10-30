import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrentPool } from '../src/tasks.ts';

test('concurrentPool runs jobs through a capped pool and reports p50/p95', async () => {
  const r = await concurrentPool(4, 2, 10);
  assert.equal(r.task, 'concurrent-tasks');
  assert.equal(r.samples?.length, 4);
  assert.equal(r.meta?.jobs, 4);
  assert.equal(r.meta?.cap, 2);
  assert.ok((r.p50Ms ?? 0) > 0);
  assert.ok((r.p95Ms ?? 0) >= (r.p50Ms ?? 0));
  // 4 x 10ms through 2 workers: wall well under a generous bound.
  assert.ok(r.ms < 30_000);
});
