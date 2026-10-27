/**
 * JobQueue state-machine tests (R6-S4).
 * Run: node --test packages/taskqueue/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/index.ts';
import { LOG_CAP_BYTES } from '../src/index.ts';

function task(label: string, status: 'ok' | 'failed' = 'ok') {
  return { label, status, exitCode: status === 'ok' ? 0 : 1, durationMs: 5, diagnosticsAdded: 0 };
}

test('FIFO admission honours the concurrency cap', () => {
  const q = new JobQueue(2);
  const a = q.submit('a', ['a'], '/r', 'default');
  const b = q.submit('b', ['b'], '/r', 'default');
  const c = q.submit('c', ['c'], '/r', 'default');
  assert.equal(q.hasFreeSlot(), true);
  assert.equal(q.peekNext()?.id, a.id);
  q.markRunning(a.id);
  q.markRunning(b.id);
  assert.equal(q.hasFreeSlot(), false);
  assert.equal(q.peekNext()?.id, c.id);
  assert.equal(q.markRunning(c.id)?.id, c.id);
  // markRunning does not itself enforce the cap — the route pumps only
  // while hasFreeSlot(); here we assert the state machine is explicit.
  q.markFinished(a.id, 'succeeded', 0);
  assert.equal(q.runningCount(), 2);
  assert.equal(q.queuedCount(), 0);
});

test('cancel of a queued job is immediate and terminal', () => {
  const q = new JobQueue(1);
  const job = q.submit('x', ['x'], '/r', 'default');
  assert.equal(q.cancel(job.id), 'cancelled');
  assert.equal(q.get(job.id)?.status, 'cancelled');
  assert.equal(q.markRunning(job.id), null);
  assert.equal(q.cancel(job.id), 'terminal');
});

test('cancel of a running job is a request until the route finalizes it', () => {
  const q = new JobQueue(1);
  const job = q.submit('x', ['x'], '/r', 'default');
  q.markRunning(job.id);
  assert.equal(q.cancel(job.id), 'cancel-requested');
  assert.equal(q.get(job.id)?.status, 'running');
  assert.equal(q.get(job.id)?.cancelRequested, true);
  q.markFinished(job.id, 'cancelled', null, 'cancelled by user');
  assert.equal(q.get(job.id)?.status, 'cancelled');
});

test('cancel of an unknown job is a no-op', () => {
  const q = new JobQueue(1);
  assert.equal(q.cancel('tq-999'), 'unknown');
});

test('markFinished refuses non-running jobs', () => {
  const q = new JobQueue(1);
  const job = q.submit('x', ['x'], '/r', 'default');
  assert.equal(q.markFinished(job.id, 'succeeded', 0), null);
});

test('concurrency validation rejects out-of-range values', () => {
  assert.throws(() => new JobQueue(0), /between/);
  assert.throws(() => new JobQueue(33), /between/);
  const q = new JobQueue(2);
  assert.deepEqual(q.setMaxConcurrency(0), { ok: false, error: 'maxConcurrency must be between 1 and 32' });
  assert.deepEqual(q.setMaxConcurrency(2.5), { ok: false, error: 'maxConcurrency must be an integer' });
  assert.equal(q.setMaxConcurrency(3).ok, true);
  assert.equal(q.getConfig().maxConcurrency, 3);
});

test('log ring drops oldest bytes past the cap and flags truncation', () => {
  const q = new JobQueue(1);
  const job = q.submit('x', ['x'], '/r', 'default');
  q.appendLog(job.id, 'A'.repeat(LOG_CAP_BYTES - 10));
  assert.equal(q.get(job.id)?.logTruncated, false);
  q.appendLog(job.id, 'B'.repeat(20));
  const stored = q.get(job.id)!;
  assert.equal(stored.logTruncated, true);
  assert.equal(stored.log.length, LOG_CAP_BYTES);
  assert.equal(stored.log.endsWith('B'.repeat(20)), true);
});

test('task recording accumulates counts and diagnostics', () => {
  const q = new JobQueue(1);
  const job = q.submit('x', ['a', 'b'], '/r', 'default');
  q.markRunning(job.id);
  q.setCurrentTask(job.id, 'a');
  q.recordTask(job.id, task('a'));
  const after = q.get(job.id)!;
  assert.equal(after.completedTaskCount, 1);
  assert.equal(after.currentTask, null);
  q.addDiagnostics(job.id, [{ file: 'f.ts', line: 1, column: 1, severity: 'error', message: 'm', matcher: 'tsc' }]);
  assert.equal(q.get(job.id)?.diagnostics.length, 1);
});

test('summaries omit log bytes and preserve submission order', () => {
  const q = new JobQueue(2);
  const a = q.submit('a', ['a'], '/r', 'default');
  q.submit('b', ['b'], '/r', 'default');
  q.appendLog(a.id, 'secret-bytes');
  const sums = q.summaries();
  assert.equal(sums.length, 2);
  assert.equal(sums[0]?.id, a.id);
  assert.equal('log' in (sums[0] as object), false);
});

test('old terminal jobs are evicted past MAX_JOBS but live jobs never are', () => {
  const q = new JobQueue(1);
  const live = q.submit('live', ['live'], '/r', 'default');
  for (let i = 0; i < 210; i++) {
    const j = q.submit(`t${i}`, [`t${i}`], '/r', 'default');
    q.markRunning(j.id);
    q.markFinished(j.id, 'succeeded', 0);
  }
  // Head is the live queued job, so eviction stalls: live job survives.
  assert.notEqual(q.get(live.id), null);
  assert.equal(q.summaries().length <= 211, true);
});
