/**
 * Desktop unit tests for the V3R3-#5 command overview pure helpers.
 * node:test + node:assert/strict. React-free pure module, no DOM.
 * Run: node --test apps/desktop/tests/unit/command-overview.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../src/components/commandOverview.ts');
const { CLOUD_GATE, summarizeRuns, summarizeQueue, summarizeBudgets } = mod;

test('cloud gate is disconnected and the module never synthesizes cloud rows', () => {
  assert.equal(CLOUD_GATE.connected, false);
  assert.equal(CLOUD_GATE.reason, 'audit-1-pending');
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['CLOUD_GATE', 'summarizeBudgets', 'summarizeQueue', 'summarizeRuns'],
    'no cloud-row builder may exist in this module',
  );
});

test('summarizeRuns caps rows at 5 and counts ok/failed over the full input', () => {
  const runs = Array.from({ length: 7 }, (_, i) => ({
    id: `r${i}`, label: `chain-${i}`, ok: i % 2 === 0, taskCount: 2,
    finishedAt: '2026-11-03T00:00:00Z', persisted: i === 6,
  }));
  const s = summarizeRuns(runs);
  assert.equal(s.rows.length, 5);
  assert.equal(s.okCount, 4);
  assert.equal(s.failCount, 3);
  assert.equal(s.rows[4].persisted, false);
});

test('summarizeRuns flags persisted rows and keeps them metadata-only', () => {
  const s = summarizeRuns([
    { id: 'p1', label: 'old', ok: true, taskCount: 1, finishedAt: '2026-11-02T00:00:00Z', persisted: true },
  ]);
  assert.equal(s.rows[0].persisted, true);
  assert.ok(!('steps' in s.rows[0]), 'persisted rows must not carry step data');
});

test('summarizeRuns on empty input yields empty rows and zero counts', () => {
  const s = summarizeRuns([]);
  assert.deepEqual(s.rows, []);
  assert.equal(s.okCount, 0);
  assert.equal(s.failCount, 0);
});

test('summarizeQueue passes counts through and caps jobs at 5', () => {
  const jobs = Array.from({ length: 6 }, (_, i) => ({ id: `j${i}`, label: `job-${i}`, status: 'queued' }));
  const s = summarizeQueue({ running: 1, queued: 6, maxConcurrency: 4, jobs });
  assert.equal(s.running, 1);
  assert.equal(s.queued, 6);
  assert.equal(s.maxConcurrency, 4);
  assert.equal(s.jobs.length, 5);
});

test('summarizeQueue surfaces running jobs first with progress fields', () => {
  const s = summarizeQueue({
    running: 1, queued: 1, maxConcurrency: 2,
    jobs: [
      { id: 'q1', label: 'queued-one', status: 'queued' },
      { id: 'f1', label: 'done-one', status: 'succeeded' },
      {
        id: 'r1', label: 'running-one', status: 'running',
        currentTask: 'step-b', completedTaskCount: 1, taskCount: 3,
        startedAt: '2026-11-03T01:00:00Z',
      },
    ],
  });
  assert.deepEqual(s.jobs.map((j) => j.id), ['r1', 'q1', 'f1']);
  assert.equal(s.jobs[0].currentTask, 'step-b');
  assert.equal(s.jobs[0].completedTaskCount, 1);
  assert.equal(s.jobs[0].taskCount, 3);
  assert.equal(s.jobs[0].startedAt, '2026-11-03T01:00:00Z');
});

test('summarizeQueue defaults missing progress fields instead of dropping rows', () => {
  const s = summarizeQueue({
    running: 0, queued: 1, maxConcurrency: 2,
    jobs: [{ id: 'q1', label: 'queued-one', status: 'queued' }],
  });
  assert.equal(s.jobs[0].currentTask, null);
  assert.equal(s.jobs[0].completedTaskCount, 0);
  assert.equal(s.jobs[0].taskCount, 0);
  assert.equal(s.jobs[0].startedAt, null);
});

test('summarizeBudgets marks every row estimated and counts tripped/warned', () => {
  const s = summarizeBudgets([
    { budget: { id: 'b1', scope: 'project', scopeKey: 'p', unit: 'usd-estimate' }, used: 9, limit: 10, pct: 90, status: 'warned' },
    { budget: { id: 'b2', scope: 'task', scopeKey: 't', unit: 'calls' }, used: 10, limit: 10, pct: 100, status: 'tripped' },
  ]);
  assert.ok(s.rows.every((r) => r.estimated === true), 'budget rows are estimates, never measured consumption');
  assert.equal(s.warned, 1);
  assert.equal(s.tripped, 1);
});
