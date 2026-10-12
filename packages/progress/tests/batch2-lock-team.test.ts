/**
 * Batch 2 — §20 G-27 (weight_plan_version locking) + G-28 (team aggregation).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidWeightError,
  PlanLockedError,
  ProgressError,
  aggregateTeamProgress,
  computeProgress,
  defaultWeightPlan,
  isPlanLocked,
  lockWeightPlan,
  newPlanVersion,
  supersedePlan,
  updatePlanItems,
  type CompletionEntry,
  type ProgressReport,
} from '../src/index';

const NOW = 1700000000000;
const now = () => NOW;
const ISO = new Date(NOW).toISOString();

// §20 (G-25) test-data correction: entries used to carry evidenceRef:
// null with c > 0, which computeProgress now rejects — positive cᵢ must
// be backed by evidence. Default to a synthetic ref.
function entry(itemId: string, c: number): CompletionEntry {
  return { itemId, c, evidenceRef: `ev-${itemId}` };
}

function report(percent: number): ProgressReport {
  return {
    planId: 'p', planVersion: 1, calculationVersion: 'progress/v2.0',
    currentGate: null,
    percent, numerator: percent, denominator: 100, items: [],
    sealFinalized: false, blockers: [], updatedAt: ISO,
  };
}

describe('lockWeightPlan (§20.3 G-27)', () => {
  it('locks, records authorization, does not mutate the input', () => {
    const plan = defaultWeightPlan(now);
    const locked = lockWeightPlan(plan, 'human-1', { now, note: 'planning complete' });
    assert.equal(isPlanLocked(locked), true);
    assert.equal(locked.locked, true);
    assert.equal(locked.lockedBy, 'human-1');
    assert.equal(locked.lockedAt, ISO);
    assert.equal(locked.authorizations.at(-1)?.by, 'human-1');
    assert.match(locked.authorizations.at(-1)?.note ?? '', /planning complete/);
    // input untouched
    assert.equal(isPlanLocked(plan), false);
    assert.equal(plan.authorizations.length, 0);
  });

  it('requires an authorized actor and refuses double-locking', () => {
    const plan = defaultWeightPlan(now);
    assert.throws(() => lockWeightPlan(plan, '', { now }), /authorized actor/);
    const locked = lockWeightPlan(plan, 'human-1', { now });
    assert.throws(() => lockWeightPlan(locked, 'human-2', { now }), PlanLockedError);
  });

  it('legacy plans without lock fields are treated as unlocked', () => {
    const plan = defaultWeightPlan(now);
    delete plan.locked; delete plan.lockedAt; delete plan.lockedBy;
    assert.equal(isPlanLocked(plan), false);
  });

  it('computeProgress works on a locked plan and reports planVersion', () => {
    const locked = lockWeightPlan(defaultWeightPlan(now), 'human-1', { now });
    const r = computeProgress(locked, [entry('planning', 1)], { now });
    assert.equal(r.percent, 10);
    assert.equal(r.planVersion, 1);
    assert.equal(r.planId, locked.id);
  });
});

describe('updatePlanItems / supersedePlan (§20.3 G-27)', () => {
  it('unlocked plan: direct change keeps the version', () => {
    const plan = defaultWeightPlan(now);
    const items = plan.items.map((i) => (i.id === 'planning' ? { ...i, weight: 20 } : i));
    const changed = updatePlanItems(plan, items, { by: 'planner-1' });
    assert.equal(changed.version, 1);
    assert.equal(changed.items.find((i) => i.id === 'planning')?.weight, 20);
    assert.equal(plan.items.find((i) => i.id === 'planning')?.weight, 10);
  });

  it('locked plan: direct change throws PlanLockedError', () => {
    const locked = lockWeightPlan(defaultWeightPlan(now), 'human-1', { now });
    const items = locked.items.map((i) => ({ ...i, weight: 5 }));
    assert.throws(() => updatePlanItems(locked, items, { by: 'planner-1' }), PlanLockedError);
    assert.throws(() => updatePlanItems(locked, items), /supersedePlan/);
  });

  it('locked plan: supersede makes version+1, records note+authorization, old plan intact', () => {
    const locked = lockWeightPlan(defaultWeightPlan(now), 'human-1', { now });
    const items = locked.items.filter((i) => i.id !== 'uat');
    const v2 = supersedePlan(locked, items, {
      by: 'human-1', scopeChangeNote: 'UAT waived: internal tool', now,
    });
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedes, 1);
    assert.equal(v2.scopeChangeNote, 'UAT waived: internal tool');
    assert.equal(v2.authorizations.at(-1)?.by, 'human-1');
    assert.equal(isPlanLocked(v2), false); // new version starts unlocked
    // old plan unchanged
    assert.equal(locked.version, 1);
    assert.equal(locked.items.length, 7);
    assert.equal(isPlanLocked(locked), true);
    // progress on the superseded plan uses the new denominator
    const r = computeProgress(v2, [entry('planning', 1)], { now });
    assert.equal(r.planVersion, 2);
    assert.equal(r.percent, 11.11); // 10/90
  });

  it('supersede requires actor + scopeChangeNote + positive weights', () => {
    const locked = lockWeightPlan(defaultWeightPlan(now), 'human-1', { now });
    assert.throws(
      () => supersedePlan(locked, locked.items, { by: '', scopeChangeNote: 'x', now }),
      /authorized actor/,
    );
    assert.throws(
      () => supersedePlan(locked, locked.items, { by: 'h', scopeChangeNote: '', now }),
      /scopeChangeNote/,
    );
    assert.throws(
      () => supersedePlan(locked, [{ ...locked.items[0], weight: 0 }], { by: 'h', scopeChangeNote: 'x', now }),
      InvalidWeightError,
    );
  });

  it('newPlanVersion remains an authorized supersede path for locked plans', () => {
    const locked = lockWeightPlan(defaultWeightPlan(now), 'human-1', { now });
    const v2 = newPlanVersion(locked, (items) => items.filter((i) => i.id !== 'uat'), 'drop uat', 'human-1', { now });
    assert.equal(v2.version, 2);
    assert.equal(isPlanLocked(v2), false);
  });
});

describe('aggregateTeamProgress (§20 G-28)', () => {
  it('weights percents by goal weight: Σ(w×p)/Σw', () => {
    const agg = aggregateTeamProgress([
      { goalId: 'g1', teamId: 'team-a', weight: 2, report: report(50) },
      { goalId: 'g2', weight: 1, report: report(80) },
      { goalId: 'g3', weight: 1, report: report(20) },
    ]);
    // (2*50 + 80 + 20) / 4 = 50
    assert.equal(agg.percent, 50);
    assert.equal(agg.totalWeight, 4);
    assert.equal(agg.entries.length, 3);
    assert.equal(agg.entries[0].contribution, 100);
    assert.equal(agg.entries[0].weightSharePercent, 50);
    assert.equal(agg.entries[0].teamId, 'team-a');
    assert.equal(agg.entries[1].teamId, null);
  });

  it('rounds the aggregate percent to 2 decimals', () => {
    const agg = aggregateTeamProgress([
      { goalId: 'g1', weight: 1, report: report(10) },
      { goalId: 'g2', weight: 2, report: report(11) },
    ]);
    assert.equal(agg.percent, 10.67); // 32/3
  });

  it('empty array throws (explicit policy, no fake 0%)', () => {
    assert.throws(() => aggregateTeamProgress([]), ProgressError);
  });

  it('weight ≤ 0 throws InvalidWeightError', () => {
    assert.throws(
      () => aggregateTeamProgress([{ goalId: 'g1', weight: 0, report: report(10) }]),
      InvalidWeightError,
    );
    assert.throws(
      () => aggregateTeamProgress([{ goalId: 'g1', weight: -3, report: report(10) }]),
      /must be > 0/,
    );
  });

  it('aggregates real computeProgress reports end-to-end', () => {
    const plan = defaultWeightPlan(now);
    const r1 = computeProgress(plan, [entry('planning', 1), entry('implementation', 1)], { now }); // 40
    const r2 = computeProgress(plan, plan.items.map((i) => entry(i.id, 1)), { now }); // 100
    const agg = aggregateTeamProgress([
      { goalId: 'goal-a', weight: 3, report: r1 },
      { goalId: 'goal-b', weight: 1, report: r2 },
    ]);
    assert.equal(agg.percent, 55); // (3*40 + 100)/4
  });
});
