import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGate, loadBaseline } from '../src/gate.js';
import type { PerfResult } from '../src/types.js';

function result(tasks: Array<{ task: string; ms: number; skipped?: boolean }>): PerfResult {
  return {
    tool: '@ai-factory/perfbench',
    version: '0.1.0',
    generatedAt: '2026-10-30T00:00:00.000Z',
    seed: 42,
    synthetic: true,
    scale: 'small',
    env: { node: 'v24', platform: 'linux', arch: 'x64', cpus: 4, totalMemMb: 8192, gitRev: null },
    tasks: tasks.map((t) => ({ task: t.task, ms: t.ms, skipped: t.skipped })),
    notes: [],
  };
}

test('gate flags a regression above threshold and passes below it', () => {
  const base = result([{ task: 'index-small', ms: 1000 }]);
  const over = result([{ task: 'index-small', ms: 1300 }]);
  const v = checkGate(over, base, { thresholdPct: 20, mode: 'warn' });
  assert.equal(v.passed, true); // warn mode never fails
  assert.equal(v.warnings.length, 1);
  assert.equal(v.items[0]?.regressed, true);
  assert.ok(Math.abs((v.items[0]?.changePct ?? 0) - 30) < 0.001);

  const under = result([{ task: 'index-small', ms: 1190 }]);
  const v2 = checkGate(under, base, { thresholdPct: 20, mode: 'block' });
  assert.equal(v2.passed, true);
  assert.equal(v2.failures.length, 0);
});

test('gate boundary: exactly at threshold is not a regression', () => {
  const base = result([{ task: 'index-small', ms: 1000 }]);
  const at = result([{ task: 'index-small', ms: 1200 }]);
  const v = checkGate(at, base, { thresholdPct: 20, mode: 'block' });
  assert.equal(v.items[0]?.regressed, false);
  assert.equal(v.passed, true);
});

test('block mode fails on regression; skipped and unknown tasks are ignored', () => {
  const base = result([
    { task: 'index-small', ms: 1000 },
    { task: 'gone-task', ms: 500 },
  ]);
  const cur = result([
    { task: 'index-small', ms: 1500 },
    { task: 'new-task', ms: 10 },
    { task: 'skipped-task', ms: 0, skipped: true },
  ]);
  const v = checkGate(cur, base, { thresholdPct: 20, mode: 'block' });
  assert.equal(v.passed, false);
  assert.equal(v.failures.length, 1);
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0]?.task, 'index-small');
});

test('missing or corrupt baseline passes with noBaseline', () => {
  const cur = result([{ task: 'index-small', ms: 100 }]);
  const v = checkGate(cur, null, { thresholdPct: 20, mode: 'block' });
  assert.equal(v.passed, true);
  assert.equal(v.noBaseline, true);
  assert.equal(loadBaseline(null), null);
  assert.equal(loadBaseline('not json'), null);
  assert.equal(loadBaseline('{"tasks": "nope"}'), null);
});
