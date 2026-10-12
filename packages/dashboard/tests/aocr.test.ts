/**
 * Batch 2 — §1.2 primary metric: Authorized Outcome Completion Rate (AOCR).
 *
 * SPEC_V2 §1.2 (line 64): "主要指标为 Authorized Outcome Completion Rate：
 * 获准目标在范围、预算和风险边界内达成的比例。"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAuthorizedOutcomeCompletionRate as aocr,
  computeDashboardStats,
  NO_DATA_NOTE,
  type DashboardInput,
  type OutcomeSnapshot,
} from '../src/index';

const EMPTY: DashboardInput = {
  tasks: [], agents: [], qaRuns: [], deployments: [], approvals: [],
};

function outcome(id: string, p: Partial<OutcomeSnapshot> = {}): OutcomeSnapshot {
  return { id, authorized: true, completed: false, ...p };
}

describe('computeAuthorizedOutcomeCompletionRate (§1.2)', () => {
  it('counts only authorized + completed + within-bounds outcomes', () => {
    const r = aocr([
      outcome('o1', { completed: true }),
      outcome('o2', { completed: true, withinBudget: true, withinScope: true, withinRisk: true }),
      outcome('o3', { completed: false }),
      outcome('o4', { completed: true, withinBudget: false }), // over budget → not achieved
      outcome('o5', { completed: true, withinRisk: false }), // out of risk bounds → not achieved
      outcome('o6', { completed: true, authorized: false }), // unauthorized → excluded entirely
    ]);
    assert.equal(r.authorizedTotal, 5);
    assert.equal(r.authorizedCompleted, 2);
    assert.equal(r.ratePercent, 40);
  });

  it('denominator 0 → null, never a fabricated 100%', () => {
    assert.equal(aocr([]).ratePercent, null);
    assert.equal(aocr([outcome('x', { authorized: false, completed: true })]).ratePercent, null);
    assert.equal(aocr([outcome('x', { authorized: false, completed: true })]).authorizedTotal, 0);
  });

  it('100% only when every authorized outcome completed within bounds', () => {
    const r = aocr([outcome('a', { completed: true }), outcome('b', { completed: true })]);
    assert.equal(r.ratePercent, 100);
  });
});

describe('AOCR as the dashboard primary metric (§1.2)', () => {
  it('is present in DashboardMetrics with % unit', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      outcomes: [
        outcome('o1', { completed: true }),
        outcome('o2', { completed: false }),
        outcome('o3', { completed: true }),
        outcome('o4', { completed: true, withinScope: false }),
      ],
    });
    const stat = s.metrics.authorizedOutcomeCompletionRate;
    assert.equal(stat.value, 50); // 2 of 4 authorized, within bounds
    assert.equal(stat.unit, '%');
    assert.match(stat.label, /AOCR/);
  });

  it('no outcomes → null + 暂无数据 (like every other stat)', () => {
    const s = computeDashboardStats(EMPTY, { now: () => 0 });
    const stat = s.metrics.authorizedOutcomeCompletionRate;
    assert.equal(stat.value, null);
    assert.equal(stat.note, NO_DATA_NOTE);
  });

  it('outcomes present but none authorized → still null, not 100%', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      outcomes: [outcome('o1', { authorized: false, completed: true })],
    });
    assert.equal(s.metrics.authorizedOutcomeCompletionRate.value, null);
  });
});
