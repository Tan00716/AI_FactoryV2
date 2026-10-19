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
