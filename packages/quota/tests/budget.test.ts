/**
 * Cost-governor tests — V3.0 audit suggestion #8 (policy layer).
 *
 * Run (compiled): node --test packages/quota/dist/tests/budget.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CostGovernor,
  COST_CONVERSION_TABLE,
  DEFAULT_BUDGET_POLICY,
  defaultBudgetInputsForProject,
  estimateFromConversionTable,
  type BudgetInput,
} from '../src/index';

function govAt(ms: number): CostGovernor {
  let t = ms;
  const g = new CostGovernor({ now: () => t });
  void t;
  return g;
}

describe('budget validation (fail-closed)', () => {
  it('rejects zero, negative, infinite limits', () => {
    const g = new CostGovernor();
    for (const limit of [0, -5, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(
        () => g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'usd-estimate', limit }),
        /limit must be finite and > 0/,
      );
    }
  });

  it('rejects unknown scope/unit/period and empty keys', () => {
    const g = new CostGovernor();
    assert.throws(() => g.createBudget({ scope: 'team' as never, scopeKey: 'p1', unit: 'calls', limit: 5 }), /unknown budget scope/);
    assert.throws(() => g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'credits' as never, limit: 5 }), /unknown budget unit/);
    assert.throws(() => g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'calls', limit: 5, period: 'yearly' as never }), /unknown budget period/);
    assert.throws(() => g.createBudget({ scope: 'project', scopeKey: '  ', unit: 'calls', limit: 5 }), /scopeKey must be/);
  });

  it('refuses a duplicate scope+key+unit+period instead of overwriting', () => {
    const g = new CostGovernor();
    const input: BudgetInput = { scope: 'project', scopeKey: 'p1', unit: 'usd-estimate', limit: 10, period: 'monthly' };
    g.createBudget(input);
    assert.throws(() => g.createBudget({ ...input, limit: 99 }), /already exists/);
    assert.equal(g.listBudgets()[0].limit, 10);
  });
});

describe('warn then trip then release', () => {
  it('warns once at 80%, trips once at 100%, blocks new calls', () => {
    const g = new CostGovernor({ now: () => Date.parse('2026-10-30T10:00:00Z') });
    const b = g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'usd-estimate', limit: 10, period: 'monthly' });
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);

    const r1 = g.recordUsage({ projectId: 'p1', costUsd: 8, source: 'simulated' });
    assert.equal(r1.warned.length, 1);
    assert.equal(r1.tripped.length, 0);
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);

    // Second record in the same window must not re-warn.
    const r2 = g.recordUsage({ projectId: 'p1', costUsd: 0.5, source: 'simulated' });
    assert.equal(r2.warned.length, 0);

    const r3 = g.recordUsage({ projectId: 'p1', costUsd: 2, source: 'simulated' });
    assert.equal(r3.tripped.length, 1);
    const blocked = g.checkAllowed({ projectId: 'p1' });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.blocking[0].budget.id, b.id);
    // Other projects are unaffected.
    assert.equal(g.checkAllowed({ projectId: 'p2' }).allowed, true);

    // Release needs a reason, clears the trip, never raises the limit.
    assert.throws(() => g.releaseBudget(b.id, '  '), /reason/);
    const rel = g.releaseBudget(b.id, 'operator override: month-end closeout');
    assert.equal(rel.budgetId, b.id);
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);
    assert.equal(g.getBudget(b.id)?.limit, 10);
    assert.equal(g.usageSummary().find((u) => u.budget.id === b.id)?.status, 'released');
  });

  it('three scopes are independent: task/person/project tallies do not mix', () => {
    const g = new CostGovernor({ now: () => Date.parse('2026-10-30T10:00:00Z') });
    g.createBudget({ scope: 'task', scopeKey: 't1', unit: 'calls', limit: 2, period: 'all-time' });
    g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'calls', limit: 100, period: 'all-time' });
    const r = g.recordUsage({ taskId: 't1', projectId: 'p1', calls: 2, source: 'simulated' });
    assert.equal(r.tripped.length, 1);
    assert.equal(r.tripped[0].scope, 'task');
    assert.equal(g.checkAllowed({ taskId: 't1', projectId: 'p1' }).allowed, false);
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);
  });

  it('usage units map per budget unit (calls vs tokens vs usd)', () => {
    const g = new CostGovernor({ now: () => Date.parse('2026-10-30T10:00:00Z') });
    g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'tokens-estimate', limit: 1000, period: 'monthly' });
    g.recordUsage({ projectId: 'p1', inputTokens: 600, outputTokens: 400, costUsd: 999, calls: 999, source: 'simulated' });
    const view = g.usageSummary()[0];
    assert.equal(view.used, 1000);
    assert.equal(view.status, 'tripped');
  });

  it('a new window resets warn/trip state (daily period)', () => {
    let t = Date.parse('2026-10-30T10:00:00Z');
    const g = new CostGovernor({ now: () => t });
    const b = g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'calls', limit: 1, period: 'daily' });
    g.recordUsage({ projectId: 'p1', calls: 1, source: 'simulated' });
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, false);
    t = Date.parse('2026-10-31T10:00:00Z');
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);
    assert.equal(g.usageSummary().find((u) => u.budget.id === b.id)?.used, 0);
  });

  it('disabled budgets never warn, trip, or block', () => {
    const g = new CostGovernor();
    g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'calls', limit: 1, period: 'all-time', enabled: false });
    const r = g.recordUsage({ projectId: 'p1', calls: 50, source: 'simulated' });
    assert.equal(r.tripped.length, 0);
    assert.equal(g.checkAllowed({ projectId: 'p1' }).allowed, true);
  });
});

describe('defaults (never overwrite)', () => {
  it('default policy: caps on, auto-renew off, conservative project cap', () => {
    assert.equal(DEFAULT_BUDGET_POLICY.capEnabledByDefault, true);
    assert.equal(DEFAULT_BUDGET_POLICY.autoRenewDefault, false);
    assert.equal(DEFAULT_BUDGET_POLICY.defaultProjectBudget.limit, 10);
    const inputs = defaultBudgetInputsForProject('proj-x');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].scope, 'project');
    assert.equal(inputs[0].scopeKey, 'proj-x');
  });

  it('applyDefaults is idempotent and keeps an existing budget verbatim', () => {
    const g = new CostGovernor();
    g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'usd-estimate', limit: 500, period: 'monthly' });
    const r = g.applyDefaults('p1');
    assert.equal(r.created.length, 0);
    assert.equal(r.existing.length, 1);
    assert.equal(r.existing[0].limit, 500);
    const r2 = g.applyDefaults('p2');
    assert.equal(r2.created.length, 1);
    assert.equal(r2.created[0].limit, 10);
  });
});

describe('conversion table honesty', () => {
  it('every row is unmeasured with a pending-measurement note', () => {
    assert.ok(COST_CONVERSION_TABLE.length >= 1);
    for (const row of COST_CONVERSION_TABLE) {
      assert.equal(row.measured, false);
      assert.match(row.note, /待模型接通后实测|placeholder/);
    }
  });

  it('unknown units estimate to null, never an invented number', () => {
    assert.equal(estimateFromConversionTable('no-such-unit', 3), null);
    assert.equal(estimateFromConversionTable('chat-generation', -1), null);
    const est = estimateFromConversionTable('chat-generation', 2);
    assert.ok(est !== null && est.inputTokens === 2000 && est.costUsd === 0.02);
  });
});

describe('persistence round-trip', () => {
  it('toJSON/fromJSON keeps budgets, tallies, and trip state; bad shapes fail closed', () => {
    const g = new CostGovernor({ now: () => Date.parse('2026-10-30T10:00:00Z') });
    const b = g.createBudget({ scope: 'project', scopeKey: 'p1', unit: 'calls', limit: 1, period: 'all-time' });
    g.recordUsage({ projectId: 'p1', calls: 1, source: 'simulated' });
    const g2 = CostGovernor.fromJSON(g.toJSON());
    assert.equal(g2.checkAllowed({ projectId: 'p1' }).allowed, false);
    assert.equal(g2.getBudget(b.id)?.limit, 1);
    assert.throws(() => CostGovernor.fromJSON({ version: 99, budgets: [] }), /version-1 snapshot/);
    assert.throws(() => CostGovernor.fromJSON(null), /version-1 snapshot/);
  });
});

describe('governor clock injection', () => {
  it('govAt helper keeps the suite deterministic', () => {
    const g = govAt(Date.parse('2026-10-30T00:00:00Z'));
    const b = g.createBudget({ scope: 'person', scopeKey: 'u1', unit: 'calls', limit: 5, period: 'daily' });
    assert.ok(b.id.startsWith('budget-'));
  });
});
