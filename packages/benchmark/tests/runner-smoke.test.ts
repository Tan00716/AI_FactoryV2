/**
 * Smoke test: run the full fixed task set through the real agent loop
 * with the stub adapter and pin every deterministic verdict.
 * Run: node --test dist/tests/runner-smoke.test.js (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../src/runner';
import { BENCHMARK_CASES } from '../src/tasks';

describe('benchmark task set pins deterministic verdicts (stub adapter)', () => {
  it('all 12 cases pass with their expected outcomes', async () => {
    const report = await runBenchmark({ adapter: 'stub' });
    assert.equal(report.adapter, 'stub');
    assert.equal(report.cases.length, BENCHMARK_CASES.length);
    for (const r of report.cases) {
      assert.equal(r.pass, true, `case ${r.caseId} failed: ${r.failReasons.join('; ')}`);
      assert.equal(r.outcome, r.expectedOutcome, `case ${r.caseId}: outcome drift`);
      assert.ok(r.latencyMs >= 0, r.caseId);
      assert.ok(r.tokenEstimate >= 0, r.caseId);
      // Note: budget-fails consumes one model call before the adapter is
      // ever invoked, so its measured estimate is honestly 0.
    }
    assert.equal(report.summary.passRate, 1);
  });

  it('spot-checks the interesting verdicts', async () => {
    const report = await runBenchmark({ adapter: 'stub' });
    const byId = Object.fromEntries(report.cases.map((r) => [r.caseId, r]));
    assert.equal(byId['denied-escalates'].outcome, 'escalated');
    assert.equal(byId['budget-fails'].outcome, 'failed');
    assert.equal(byId['context-budget-fails'].outcome, 'failed');
    assert.equal(byId['always-failing-tool'].outcome, 'escalated');
    assert.equal(byId['injection-quarantined'].outcome, 'completed');
    assert.ok(byId['large-prompt'].tokenEstimate > byId['noop-complete'].tokenEstimate);
  });
});
