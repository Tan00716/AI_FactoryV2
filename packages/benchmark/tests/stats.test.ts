/**
 * Tests for repeated-run aggregation + statistical regression detection (R3-T4).
 * Run: node --test dist/tests/stats.test.js (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  aggregateCaseRuns,
  mean,
  median,
  sampleStddev,
  significantSlowdown,
} from '../src/stats';
import type { CaseResult } from '../src/types';

function closeTo(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (eps ${eps})`,
  );
}

function makeRun(caseId: string, latencyMs: number, pass: boolean, failReasons: string[] = []): CaseResult {
  return {
    caseId,
    name: caseId,
    adapter: 'stub',
    pass,
    outcome: pass ? 'completed' : 'failed',
    expectedOutcome: 'completed',
    failReasons,
    latencyMs,
    steps: 6,
    modelCalls: 1,
    toolCalls: 1,
    tokenEstimate: 100,
    tokenEstimateMethod: 'test',
  };
}

describe('basic statistics', () => {
  it('computes mean/median/stddev on a known fixture', () => {
    const xs = [10, 20, 30, 40, 50];
    assert.equal(mean(xs), 30);
    assert.equal(median(xs), 30);
    assert.equal(median([10, 20, 30, 40]), 25);
    closeTo(sampleStddev(xs), Math.sqrt(250), 1e-9);
    assert.equal(sampleStddev([42]), 0);
    assert.equal(mean([]), 0);
  });

  it('aggregate() returns mean/median/approx-95% CI', () => {
    const s = aggregate([10, 20, 30, 40, 50]);
    assert.equal(s.n, 5);
    assert.equal(s.mean, 30);
    assert.equal(s.median, 30);
    closeTo(s.stddev, Math.sqrt(250), 1e-9);
    // half-width = 1.96 * sqrt(250) / sqrt(5) ≈ 13.86
    closeTo(s.ci95[0], 30 - (1.96 * Math.sqrt(250)) / Math.sqrt(5), 1e-9);
    closeTo(s.ci95[1], 30 + (1.96 * Math.sqrt(250)) / Math.sqrt(5), 1e-9);
    assert.equal(s.min, 10);
    assert.equal(s.max, 50);
  });

  it('aggregate() on a single value has a zero-width CI', () => {
    const s = aggregate([42]);
    assert.equal(s.n, 1);
    assert.deepEqual(s.ci95, [42, 42]);
    assert.equal(s.stddev, 0);
  });
});

describe('significantSlowdown', () => {
  it('flags a clear 2x slowdown with tight samples', () => {
    assert.equal(significantSlowdown([10, 11, 12, 11, 10], [20, 21, 22, 21, 20]), true);
  });

  it('does NOT flag overlapping noisy samples (environment jitter)', () => {
    // base mean 50 CI [38.7, 61.3]; cur mean 55 CI [43.7, 66.3] — overlap.
    assert.equal(significantSlowdown([40, 50, 60], [45, 55, 65]), false);
  });

  it('does NOT flag a speedup (direction matters)', () => {
    assert.equal(significantSlowdown([20, 21, 22, 21, 20], [10, 11, 12, 11, 10]), false);
  });

  it('returns false when either side has < 2 samples (single-measurement fallback)', () => {
    assert.equal(significantSlowdown([10], [100, 101, 102]), false);
    assert.equal(significantSlowdown([10, 11, 12], [100]), false);
    assert.equal(significantSlowdown([10], [100]), false);
  });

  it('does NOT flag identical distributions', () => {
    assert.equal(significantSlowdown([10, 20, 30], [10, 20, 30]), false);
  });
});

describe('aggregateCaseRuns', () => {
  it('merges repeated runs: mean latency, samples kept, all-pass', () => {
    const merged = aggregateCaseRuns([
      makeRun('a', 40, true),
      makeRun('a', 50, true),
      makeRun('a', 60, true),
    ]);
    assert.equal(merged.caseId, 'a');
    assert.equal(merged.pass, true);
    assert.equal(merged.latencyMs, 50);
    assert.deepEqual(merged.latencySamples, [40, 50, 60]);
    assert.equal(merged.steps, 6);
    assert.deepEqual(merged.failReasons, []);
  });

  it('a single failing run fails the aggregate and merges fail reasons (deduped)', () => {
    const merged = aggregateCaseRuns([
      makeRun('a', 40, true),
      makeRun('a', 50, false, ['boom']),
      makeRun('a', 60, false, ['boom', 'timeout']),
    ]);
    assert.equal(merged.pass, false);
    assert.deepEqual(merged.failReasons, ['boom', 'timeout']);
    assert.equal(merged.outcome, 'failed'); // mode over 2 failed / 1 completed
  });

  it('outcome is the mode; ties go to the earliest run', () => {
    const merged = aggregateCaseRuns([
      makeRun('a', 40, true),
      makeRun('a', 50, false, ['x']),
    ]);
    assert.equal(merged.outcome, 'completed');
  });

  it('throws on empty input (fail-closed)', () => {
    assert.throws(() => aggregateCaseRuns([]), /at least one run/);
  });
});
