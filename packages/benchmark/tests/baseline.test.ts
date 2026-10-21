/**
 * Tests for baseline persistence + comparison.
 * Run: node --test dist/tests/baseline.test.js (after tsc -p tsconfig.json)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffBaseline,
  loadBaseline,
  reportToBaseline,
  saveBaseline,
} from '../src/baseline';
import type { Baseline, BenchmarkReport } from '../src/types';

function makeReport(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    generatedAt: '2026-10-19T00:00:00Z',
    adapter: 'stub',
    appVersion: '0.2.0',
    cases: [],
    summary: { total: 0, passed: 0, failed: 0, passRate: 0, totalLatencyMs: 0, avgLatencyMs: 0, totalTokenEstimate: 0 },
    ...overrides,
  };
}

function makeBaselineEntry(pass: boolean, latencyMs = 50) {
  return { pass, latencyMs, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 };
}

describe('baseline persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-baseline-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips through save/load', () => {
    const path = join(dir, 'stub.json');
    const baseline: Baseline = {
      adapter: 'stub',
      generatedAt: '2026-10-19T00:00:00Z',
      appVersion: '0.2.0',
      cases: { 'noop-complete': makeBaselineEntry(true) },
    };
    saveBaseline(path, baseline);
    assert.deepEqual(loadBaseline(path), baseline);
  });

  it('returns null for missing or corrupt baselines (fail-closed)', () => {
    assert.equal(loadBaseline(join(dir, 'nope.json')), null);
    const bad = join(dir, 'bad.json');
    require('node:fs').writeFileSync(bad, 'not json{{{', 'utf8');
    assert.equal(loadBaseline(bad), null);
    const wrongShape = join(dir, 'shape.json');
    require('node:fs').writeFileSync(wrongShape, '{"adapter":"stub"}', 'utf8');
    assert.equal(loadBaseline(wrongShape), null);
  });
});

describe('diffBaseline', () => {
  const base: Baseline = {
    adapter: 'stub',
    generatedAt: '2026-10-19T00:00:00Z',
    appVersion: '0.2.0',
    cases: {
      a: makeBaselineEntry(true, 50),
      b: makeBaselineEntry(false, 50),
      gone: makeBaselineEntry(true, 50),
    },
  };

  function reportFor(entries: Record<string, { pass: boolean; latencyMs: number }>): BenchmarkReport {
    return makeReport({
      cases: Object.entries(entries).map(([caseId, e]) => ({
        caseId,
        name: caseId,
        adapter: 'stub',
        pass: e.pass,
        outcome: e.pass ? 'completed' : 'failed',
        expectedOutcome: 'completed' as const,
        failReasons: [],
        latencyMs: e.latencyMs,
        steps: 6,
        modelCalls: 1,
        toolCalls: 1,
        tokenEstimate: 100,
        tokenEstimateMethod: 'test',
      })),
    });
  }

  it('detects regressions, fixes, new and removed cases', () => {
    const cmp = diffBaseline(
      base,
      reportFor({ a: { pass: false, latencyMs: 50 }, b: { pass: true, latencyMs: 50 }, c: { pass: true, latencyMs: 50 } }),
    );
    assert.deepEqual(cmp.regressions, ['a']);
    assert.deepEqual(cmp.newCases, ['c']);
    assert.deepEqual(cmp.removedCases, ['gone']);
    const byId = Object.fromEntries(cmp.diffs.map((d) => [d.caseId, d.status]));
    assert.equal(byId['a'], 'regression');
    assert.equal(byId['b'], 'fixed');
    assert.equal(byId['c'], 'new');
    assert.equal(byId['gone'], 'removed');
  });

  it('flags latency drift beyond tolerance as a note, not a regression', () => {
    const cmp = diffBaseline(base, reportFor({ a: { pass: true, latencyMs: 200 }, b: { pass: false, latencyMs: 50 }, gone: { pass: true, latencyMs: 50 } }), { latencyTolerance: 1.0 });
    assert.deepEqual(cmp.regressions, []);
    const a = cmp.diffs.find((d) => d.caseId === 'a')!;
    assert.equal(a.status, 'unchanged');
    assert.ok(a.notes.some((n) => n.startsWith('latency drift')), 'expected a latency drift note');
  });

  it('reportToBaseline keys entries by case id', () => {
    const baseline = reportToBaseline(reportFor({ a: { pass: true, latencyMs: 42 } }));
    assert.equal(baseline.cases['a'].latencyMs, 42);
    assert.equal(baseline.cases['a'].pass, true);
  });
});

describe('diffBaseline with repeated runs (R3-T4)', () => {
  const base: Baseline = {
    adapter: 'stub',
    generatedAt: '2026-10-19T00:00:00Z',
    appVersion: '0.2.0',
    cases: {
      a: { ...{ pass: true, latencyMs: 11, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 }, latencySamples: [10, 11, 12, 11, 10] },
      noisy: { ...{ pass: true, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 }, latencySamples: [40, 50, 60] },
    },
  };

  function reportWithSamples(entries: Record<string, { pass: boolean; samples: number[] }>): BenchmarkReport {
    return makeReport({
      cases: Object.entries(entries).map(([caseId, e]) => {
        const m = e.samples.reduce((x, y) => x + y, 0) / e.samples.length;
        return {
          caseId,
          name: caseId,
          adapter: 'stub',
          pass: e.pass,
          outcome: e.pass ? 'completed' : 'failed',
          expectedOutcome: 'completed' as const,
          failReasons: [],
          latencyMs: Math.round(m),
          latencySamples: [...e.samples],
          steps: 6,
          modelCalls: 1,
          toolCalls: 1,
          tokenEstimate: 100,
          tokenEstimateMethod: 'test',
        };
      }),
    });
  }

  it('flags a statistically significant 2x slowdown as a note, not a regression', () => {
    const cmp = diffBaseline(
      base,
      reportWithSamples({
        a: { pass: true, samples: [20, 21, 22, 21, 20] },
        noisy: { pass: true, samples: [45, 55, 65] },
      }),
    );
    assert.deepEqual(cmp.regressions, [], 'latency must never be a gate regression');
    const a = cmp.diffs.find((d) => d.caseId === 'a')!;
    assert.equal(a.status, 'unchanged');
    assert.ok(
      a.notes.some((n) => n.startsWith('latency regression (statistically significant)')),
      `expected a significant-regression note, got: ${a.notes.join(' | ')}`,
    );
    assert.ok(a.latencyStats?.significant, 'structured latencyStats must be present');
    // The noisy case has overlapping CIs: no note at all.
    const noisy = cmp.diffs.find((d) => d.caseId === 'noisy')!;
    assert.ok(
      !noisy.notes.some((n) => n.startsWith('latency')),
      `jitter must not be flagged, got: ${noisy.notes.join(' | ')}`,
    );
  });

  it('still detects pass→fail regressions across repeated runs', () => {
    const cmp = diffBaseline(
      base,
      reportWithSamples({
        a: { pass: false, samples: [20, 21, 22] },
        noisy: { pass: true, samples: [45, 55, 65] },
      }),
    );
    assert.deepEqual(cmp.regressions, ['a']);
    const a = cmp.diffs.find((d) => d.caseId === 'a')!;
    assert.equal(a.status, 'regression');
  });

  it('falls back to the tolerance rule when the baseline has a single measurement', () => {
    const singleBase: Baseline = {
      adapter: 'stub',
      generatedAt: '2026-10-19T00:00:00Z',
      appVersion: '0.2.0',
      cases: { a: { pass: true, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 } },
    };
    const cmp = diffBaseline(
      singleBase,
      reportWithSamples({ a: { pass: true, samples: [200, 210, 205] } }),
      { latencyTolerance: 1.0 },
    );
    const a = cmp.diffs.find((d) => d.caseId === 'a')!;
    assert.ok(a.notes.some((n) => n.startsWith('latency drift')), 'legacy single-sample rule must still apply');
  });

  it('reportToBaseline persists latency samples', () => {
    const b = reportToBaseline(reportWithSamples({ a: { pass: true, samples: [40, 50, 60] } }));
    assert.deepEqual(b.cases['a'].latencySamples, [40, 50, 60]);
  });
});
