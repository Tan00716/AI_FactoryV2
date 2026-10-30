/**
 * tasktimeline package tests (V3-#7).
 * Run: node --test packages/tasktimeline/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRollback, buildTimeline } from '../src/index.ts';
import type { ChainResultInput, PlannedStep } from '../src/index.ts';

function chain(overrides: Partial<ChainResultInput> = {}): ChainResultInput {
  return {
    requested: ['demo'],
    ok: false,
    stoppedAt: 'fail-step',
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: '2026-10-30T00:00:01.000Z',
    results: [
      {
        label: 'step-one', status: 'ok', exitCode: 0, durationMs: 12,
        output: 'one\n', truncated: false, diagnosticsAdded: 0, matchRate: 1,
      },
      {
        label: 'fail-step', status: 'failed', exitCode: 2, durationMs: 30,
        output: 'boom\n', truncated: false, diagnosticsAdded: 1, matchRate: 1,
        error: 'task exited with code 2',
      },
    ],
    ...overrides,
  };
}

const planned: PlannedStep[] = [
  { label: 'step-one', command: 'echo one' },
  { label: 'fail-step', command: 'node -e "process.exit(2)"' },
  { label: 'never-ran', command: 'echo never' },
];

test('buildTimeline keeps execution order and marks unrun planned steps skipped', () => {
  const run = buildTimeline('taskrun-1', chain(), planned);
  assert.equal(run.steps.length, 3);
  assert.deepEqual(run.steps.map((s) => s.label), ['step-one', 'fail-step', 'never-ran']);
  assert.equal(run.steps[2]?.status, 'skipped');
  assert.deepEqual(run.steps[2]?.notes, ['not run: the chain stopped before this step']);
  assert.equal(run.steps[2]?.outputBytes, 0);
  assert.equal(run.coverage, 'full');
  assert.equal(run.checkpointTaskId, 'demo');
  assert.equal(run.supersededFrom, null);
});

test('buildTimeline caps stored output and digests the stored bytes', () => {
  const big = 'x'.repeat(40 * 1024);
  const run = buildTimeline('taskrun-2', chain({
    ok: true,
    stoppedAt: null,
    results: [{
      label: 'big', status: 'ok', exitCode: 0, durationMs: 5,
      output: big, truncated: false, diagnosticsAdded: 0, matchRate: 1,
    }],
  }), [{ label: 'big', command: 'node big.js' }]);
  const step = run.steps[0];
  assert.equal(step?.output.length, 32 * 1024);
  assert.equal(step?.outputBytes, 40 * 1024);
  assert.equal(step?.outputTruncated, true);
  assert.match(step?.outputDigest ?? '', /^[0-9a-f]{64}$/);
});

test('buildTimeline marks unknown-command steps partial, never drops them', () => {
  const run = buildTimeline('taskrun-3', chain(), planned.slice(0, 1));
  assert.equal(run.coverage, 'partial');
  assert.match(run.coverageNote ?? '', /fail-step/);
  assert.equal(run.steps[1]?.command, null);
  // Unrun planned steps outside the known plan are not invented.
  assert.equal(run.steps.length, 2);
});

test('applyRollback supersedes later steps and preserves earlier results', () => {
  const run = buildTimeline('taskrun-1', chain(), planned);
  const { run: rolled, superseded } = applyRollback(run, 'step-one', '2026-10-30T00:01:00.000Z');
  assert.deepEqual(superseded, ['fail-step', 'never-ran']);
  assert.equal(rolled.steps[0]?.status, 'ok');
  assert.equal(rolled.steps[1]?.status, 'superseded');
  assert.equal(rolled.steps[2]?.status, 'superseded');
  // Original failure output is still in the record (audit chain continuous).
  assert.equal(rolled.steps[1]?.output, 'boom\n');
  assert.equal(rolled.steps[1]?.supersededAt, '2026-10-30T00:01:00.000Z');
  assert.equal(rolled.supersededFrom, 'step-one');
  assert.equal(rolled.rollbackCount, 1);
  // The input run is untouched (immutable).
  assert.equal(run.steps[1]?.status, 'failed');
});

test('applyRollback to the last step supersedes nothing but still records', () => {
  const run = buildTimeline('taskrun-1', chain(), planned);
  const { run: rolled, superseded } = applyRollback(run, 'never-ran', '2026-10-30T00:01:00.000Z');
  assert.deepEqual(superseded, []);
  assert.equal(rolled.supersededFrom, 'never-ran');
  assert.equal(rolled.rollbackCount, 1);
});

test('applyRollback rejects unknown and already-superseded steps', () => {
  const run = buildTimeline('taskrun-1', chain(), planned);
  assert.throws(
    () => applyRollback(run, 'nope', '2026-10-30T00:01:00.000Z'),
    (e: unknown) => (e as { code?: string }).code === 'step-not-found',
  );
  const rolled = applyRollback(run, 'step-one', '2026-10-30T00:01:00.000Z').run;
  assert.throws(
    () => applyRollback(rolled, 'fail-step', '2026-10-30T00:02:00.000Z'),
    (e: unknown) => (e as { code?: string }).code === 'already-superseded',
  );
  // Rolling further back extends the range instead of shrinking it.
  const back = applyRollback(rolled, 'step-one', '2026-10-30T00:03:00.000Z').run;
  assert.equal(back.rollbackCount, 2);
  assert.equal(back.steps[1]?.status, 'superseded');
});
