/**
 * Tests for the benchmark task set itself: id stability, valid verdicts,
 * per-run tool factories.
 * Run: node --test dist/tests/tasks.test.js (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARK_CASES, BENCHMARK_CASE_IDS } from '../src/tasks';

describe('BENCHMARK_CASES', () => {
  it('has 10–20 cases with unique, stable ids', () => {
    assert.ok(BENCHMARK_CASES.length >= 10 && BENCHMARK_CASES.length <= 20);
    assert.equal(new Set(BENCHMARK_CASE_IDS).size, BENCHMARK_CASES.length);
    for (const c of BENCHMARK_CASES) {
      assert.match(c.id, /^[a-z0-9-]+$/, `case id must be a stable slug: ${c.id}`);
    }
  });

  it('every case has a valid expected outcome and a stub script array', () => {
    for (const c of BENCHMARK_CASES) {
      assert.ok(['completed', 'failed', 'escalated'].includes(c.expectOutcome), c.id);
      assert.ok(Array.isArray(c.stubScript), c.id);
      assert.ok(c.task.acceptanceCriteria.length > 0, c.id);
    }
  });

  it('makeTools() builds a fresh record per call (stateful tools stay deterministic)', () => {
    const flaky = BENCHMARK_CASES.find((c) => c.id === 'flaky-tool-retries')!;
    const first = flaky.makeTools();
    const second = flaky.makeTools();
    assert.notEqual(first, second);
    assert.equal(typeof first['flaky'], 'function');
  });

  it('injection case forbids the injected directive verbatim', () => {
    const c = BENCHMARK_CASES.find((x) => x.id === 'injection-quarantined')!;
    assert.ok(c.forbidVerbatim && c.forbidVerbatim.length > 0);
    assert.ok(c.task.goal.includes(c.forbidVerbatim[0]), 'the tainted string must actually be in the goal');
  });
});
