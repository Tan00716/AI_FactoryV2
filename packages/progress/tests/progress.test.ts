/**
 * Tests for the deterministic progress engine — SPEC_V2 §20.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompletionEntry,
  CompletionLedger,
  applyInvalidation,
  computeProgress,
  defaultWeightPlan,
  newPlanVersion,
  splitItem,
} from '../src/index';

const NOW = 1700000000000;
const now = () => NOW;

function entry(itemId: string, c: number, evidenceRef: string | null = null): CompletionEntry {
  return { itemId, c, evidenceRef };
}

describe('computeProgress (§20.1)', () => {
  it('spec example: Planning 100% + Implementation 80% → 34%', () => {
    const plan = defaultWeightPlan(now);
    const r = computeProgress(plan, [
      entry('planning', 1, 'ev-plan'),
      entry('implementation', 0.8, 'ev-impl'),
    ], { now });
    // (10*1 + 30*0.8 + 0) / 100 = 34
    assert.equal(r.percent, 34);
    assert.equal(r.numerator, 34);
    assert.equal(r.denominator, 100);
    assert.equal(r.calculationVersion, 'progress/v2.0');
    assert.equal(r.planVersion, 1);
  });

  it('is deterministic: same inputs → identical report', () => {
    const plan = defaultWeightPlan(now);
    const cs = [entry('planning', 1), entry('implementation', 0.8)];
    const a = computeProgress(plan, cs, { now });
    const b = computeProgress(plan, cs, { now });
    assert.deepEqual(a, b);
  });

  it('empty plan progress is 0%', () => {
    const r = computeProgress(defaultWeightPlan(now), [], { now });
    assert.equal(r.percent, 0);
  });

  it('cannot reach 100% before the final seal', () => {
    const plan = defaultWeightPlan(now);
    const all = plan.items.filter((i) => i.kind !== 'seal').map((i) => entry(i.id, 1));
    const r = computeProgress(plan, all, { now });
    assert.ok(r.percent < 100, `got ${r.percent}`);
    assert.equal(r.sealFinalized, false);
    const sealed = computeProgress(plan, [...all, entry('seal', 1)], { now });
    assert.equal(sealed.percent, 100);
    assert.equal(sealed.sealFinalized, true);
  });

  it('rejects c outside [0,1]', () => {
    assert.throws(() => computeProgress(defaultWeightPlan(now), [entry('planning', 1.5)], { now }), /\[0,1\]/);
    assert.throws(() => computeProgress(defaultWeightPlan(now), [entry('planning', -0.1)], { now }), /\[0,1\]/);
  });

  it('rejects non-positive weights', () => {
    const plan = defaultWeightPlan(now);
    plan.items[0].weight = 0;
    assert.throws(() => computeProgress(plan, [], { now }), /weight must be > 0/);
  });

  it('derives c from discrete checkpoints (weighted ratio)', () => {
    const plan = defaultWeightPlan(now);
    const r = computeProgress(plan, [{
      itemId: 'implementation', c: 0, evidenceRef: 'ev-impl',
      checkpoints: [
        { id: 'cp-1', met: true, weight: 1 },
        { id: 'cp-2', met: true, weight: 1 },
        { id: 'cp-3', met: false, weight: 2 },
      ],
    }], { now });
    // implementation c = 2/4 = 0.5 → 30*0.5/100 = 15%
    assert.equal(r.percent, 15);
  });

  it('parent with children and weight → DoubleCountError', () => {
    const plan = defaultWeightPlan(now);
    plan.items.push({ id: 'phase-x', label: 'Phase X', weight: 5, kind: 'work', parentId: null });
    plan.items.push({ id: 'x-1', label: 'X.1', weight: 5, kind: 'work', parentId: 'phase-x' });
    assert.throws(() => computeProgress(plan, [], { now }), /no double counting/);
  });

  it('shared gate counted once', () => {
    const plan = defaultWeightPlan(now);
    plan.items.push(
      { id: 'extra-qa', label: 'Extra QA gate', weight: 20, kind: 'work', parentId: null, sharedGateRef: 'gate:qa' },
    );
    // give the shared ref to the existing qa item too
    plan.items.find((i) => i.id === 'qa-ci-security')!.sharedGateRef = 'gate:qa';
    const r = computeProgress(plan, [entry('qa-ci-security', 1), entry('extra-qa', 1)], { now });
    assert.equal(r.denominator, 100); // not 120
    assert.equal(r.percent, 20);
  });
});

describe('splitItem (§20.3: splitting conserves total weight)', () => {
  it('split keeps the sum; new version supersedes', () => {
    const plan = defaultWeightPlan(now);
    const v2 = splitItem(plan, 'implementation', [
      { id: 'impl-a', label: 'Impl A', weight: 18 },
      { id: 'impl-b', label: 'Impl B', weight: 12 },
    ], 'human-1', { now });
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedes, 1);
    const r = computeProgress(v2, [entry('planning', 1), entry('impl-a', 1), entry('impl-b', 0.5)], { now });
    // 10 + 18 + 6 = 34
    assert.equal(r.percent, 34);
  });

  it('split that changes total weight is rejected', () => {
    const plan = defaultWeightPlan(now);
    assert.throws(
      () => splitItem(plan, 'implementation', [{ id: 'a', label: 'A', weight: 40 }], 'human-1', { now }),
      /must not change total weight/,
    );
  });
});

describe('invalidation (§20.3: c_i may decrease, reason shown)', () => {
  it('evidence invalidation lowers progress and records the reason', () => {
    const plan = defaultWeightPlan(now);
    const completions = new Map<string, CompletionEntry>([
      ['planning', entry('planning', 1, 'ev-plan')],
      ['implementation', entry('implementation', 0.8, 'ev-impl')],
    ]);
    const before = computeProgress(plan, completions, { now });
    assert.equal(before.percent, 34);

    const ledger = new CompletionLedger({ now });
    applyInvalidation(completions, ledger, 'implementation', 0.4, 'ev-impl superseded by rework', 'qa-lead');
    const after = computeProgress(plan, completions, { now });
    // (10 + 12) / 100 = 22 — progress went DOWN, honestly
    assert.equal(after.percent, 22);
    const rec = ledger.list('implementation')[0];
    assert.equal(rec.from, 0.8);
    assert.equal(rec.to, 0.4);
    assert.match(rec.reason, /rework/);
  });

  it('invalidation cannot raise completion', () => {
    const completions = new Map<string, CompletionEntry>([['planning', entry('planning', 0.5)]]);
    const ledger = new CompletionLedger({ now });
    assert.throws(
      () => applyInvalidation(completions, ledger, 'planning', 0.9, 'x', 'qa-lead'),
      /must not raise/,
    );
  });
});

describe('newPlanVersion (§20.3: scope change, authorized)', () => {
  it('cancelled item removed from denominator only with authorization', () => {
    const plan = defaultWeightPlan(now);
    assert.throws(
      () => newPlanVersion(plan, (items) => items.filter((i) => i.id !== 'uat'), 'drop uat', '', { now }),
      /authorized actor/,
    );
    const v2 = newPlanVersion(
      plan,
      (items) => items.filter((i) => i.id !== 'uat'),
      'UAT waived by human owner: internal tool, no users',
      'human-1',
      { now },
    );
    assert.equal(v2.version, 2);
    const r = computeProgress(v2, [entry('planning', 1)], { now });
    // denominator now 90 → 10/90 = 11.11
    assert.equal(r.percent, 11.11);
    assert.equal(v2.authorizations[0].by, 'human-1');
  });
});
