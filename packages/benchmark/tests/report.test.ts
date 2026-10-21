/**
 * Tests for the CI gate + summary table.
 * Run: node --test dist/tests/report.test.js (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkGate, formatSummaryTable } from '../src/report';
import { diffBaseline } from '../src/baseline';
import type { Baseline, BenchmarkReport, CaseResult } from '../src/types';

function caseResult(caseId: string, pass: boolean, latencyMs = 50): CaseResult {
  return {
    caseId,
    name: caseId,
    adapter: 'stub',
    pass,
    outcome: pass ? 'completed' : 'failed',
    expectedOutcome: 'completed',
    failReasons: pass ? [] : ['boom'],
    latencyMs,
    steps: 6,
    modelCalls: 1,
    toolCalls: 1,
    tokenEstimate: 100,
    tokenEstimateMethod: 'test',
  };
}

function report(cases: CaseResult[]): BenchmarkReport {
  const passed = cases.filter((c) => c.pass).length;
  return {
    generatedAt: '2026-10-19T00:00:00Z',
    adapter: 'stub',
    appVersion: '0.2.0',
    cases,
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      passRate: cases.length === 0 ? 0 : passed / cases.length,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      totalTokenEstimate: 0,
    },
  };
}

function baselineFor(ids: string[], pass = true): Baseline {
  return {
    adapter: 'stub',
    generatedAt: '2026-10-19T00:00:00Z',
    appVersion: '0.2.0',
    cases: Object.fromEntries(
      ids.map((id) => [id, { pass, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 }]),
    ),
  };
}

describe('checkGate', () => {
  it('passes when everything matches the baseline', () => {
    const r = report([caseResult('a', true), caseResult('b', true)]);
    const b = baselineFor(['a', 'b']);
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, true);
    assert.deepEqual(gate.reasons, []);
  });

  it('fails on a success regression vs baseline', () => {
    const r = report([caseResult('a', false), caseResult('b', true)]);
    const b = baselineFor(['a', 'b']);
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, false);
    assert.ok(gate.reasons.some((x) => x.includes('a')), 'regression case must be named');
  });

  it('fails when pass rate drops below an explicit floor', () => {
    const r = report([caseResult('a', true), caseResult('b', false)]);
    const gate = checkGate(r, null, null, { minPassRate: 1.0 });
    assert.equal(gate.pass, false);
    assert.ok(gate.reasons.some((x) => x.includes('pass rate')));
  });

  it('defaults the floor to the baseline pass rate', () => {
    // Baseline itself was 1/2 passing: matching it must pass the gate.
    const r = report([caseResult('a', true), caseResult('b', false)]);
    const b = baselineFor(['a'], true);
    b.cases['b'] = { pass: false, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100 };
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, true);
  });

  it('surfaces latency drift as a warning, not a failure', () => {
    const r = report([caseResult('a', true, 500)]);
    const b = baselineFor(['a']);
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, true);
    assert.ok(gate.warnings.some((w) => w.includes('latency drift')));
  });

  it('surfaces a statistically significant slowdown as a warning, not a failure (R3-T4)', () => {
    const mk = (caseId: string, pass: boolean, latencyMs: number, samples: number[]): CaseResult => ({
      ...caseResult(caseId, pass, latencyMs),
      latencySamples: samples,
    });
    const r = report([
      mk('a', true, 21, [20, 21, 22, 21, 20]),
    ]);
    const b: Baseline = {
      adapter: 'stub',
      generatedAt: '2026-10-19T00:00:00Z',
      appVersion: '0.2.0',
      cases: {
        a: { pass: true, latencyMs: 11, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100, latencySamples: [10, 11, 12, 11, 10] },
      },
    };
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, true, `significant slowdown must not fail the gate: ${gate.reasons.join('; ')}`);
    assert.ok(
      gate.warnings.some((w) => w.includes('latency regression (statistically significant)')),
      `expected a significant-regression warning, got: ${gate.warnings.join(' | ')}`,
    );
  });

  it('still fails the gate when repeated runs turn pass into fail (R3-T4)', () => {
    const mk = (caseId: string, pass: boolean, samples: number[]): CaseResult => ({
      ...caseResult(caseId, pass, 50),
      latencySamples: samples,
    });
    const r = report([
      { ...mk('a', false, [50, 51, 52]), failReasons: ['boom'] },
      mk('b', true, [50, 51, 52]),
    ]);
    const b: Baseline = {
      adapter: 'stub',
      generatedAt: '2026-10-19T00:00:00Z',
      appVersion: '0.2.0',
      cases: {
        a: { pass: true, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100, latencySamples: [50, 51, 52] },
        b: { pass: true, latencyMs: 50, steps: 6, modelCalls: 1, toolCalls: 1, tokenEstimate: 100, latencySamples: [50, 51, 52] },
      },
    };
    const gate = checkGate(r, b, diffBaseline(b, r));
    assert.equal(gate.pass, false);
    assert.ok(gate.reasons.some((x) => x.includes('a')), 'regression case must be named');
  });
});

describe('formatSummaryTable', () => {
  it('renders one row per case plus the summary line', () => {
    const table = formatSummaryTable(report([caseResult('a', true), caseResult('b', false)]));
    assert.ok(table.includes('a'));
    assert.ok(table.includes('PASS'));
    assert.ok(table.includes('FAIL'));
    assert.ok(table.includes('boom'), 'fail reasons must be visible');
    assert.ok(table.includes('passRate 50.0%'));
  });
});
