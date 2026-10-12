/**
 * §21.3 Execution Strategy Optimizer (G-34): hard constraints gate
 * first, deterministic scoring second; Human Override chooses among
 * feasible candidates and is refused — with a per-constraint
 * explanation — when it aims at a rejected one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionStrategyOptimizer,
  StrategyCandidate,
} from '../src/index';

function candidate(over: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: 'c',
    dimensions: {
      parallelism: 'serial',
      staffing: 'reuse',
      model: 'm-default',
      verification: 'standard',
      host: 'local',
      context: 'full-context',
    },
    estimatedCostMinor: 1_000,
    estimatedTimeMs: 60_000,
    capabilitySatisfied: true,
    policyAllowed: true,
    ...over,
  };
}

describe('Execution Strategy Optimizer (§21.3)', () => {
  it('rejects capability/policy violators with reasons and never scores them', () => {
    const opt = new ExecutionStrategyOptimizer();
    const decision = opt.evaluate([
      candidate({ id: 'ok' }),
      candidate({
        id: 'bad',
        capabilitySatisfied: false,
        capabilityNote: 'model lacks tool calling',
        policyAllowed: false,
        policyNote: 'data class not cleared for host',
        estimatedCostMinor: 1, // cheapest — must still lose
      }),
    ]);
    assert.equal(decision.chosen, 'ok');
    assert.deepEqual(decision.ranking.map((r) => r.candidateId), ['ok']);
    assert.equal(decision.rejected.length, 1);
    assert.equal(decision.rejected[0]!.candidateId, 'bad');
    assert.equal(decision.rejected[0]!.reasons.length, 2);
    assert.match(decision.rejected[0]!.reasons[0]!, /capability/);
    assert.match(decision.rejected[0]!.reasons[0]!, /tool calling/);
    assert.match(decision.rejected[0]!.reasons[1]!, /policy/);
    assert.match(decision.rejected[0]!.reasons[1]!, /data class/);
  });

  it('scores feasible candidates deterministically (cost, time, resource)', () => {
    const opt = new ExecutionStrategyOptimizer({
      costWeight: 1,
      timeWeight: 0.01,
      resourceWeight: 10,
    });
    const decision = opt.evaluate([
      candidate({ id: 'slow-cheap', estimatedCostMinor: 100, estimatedTimeMs: 100_000 }),
      candidate({ id: 'fast-dear', estimatedCostMinor: 500, estimatedTimeMs: 10_000 }),
    ]);
    // slow-cheap: 100 + 1000 = 1100; fast-dear: 500 + 100 = 600.
    assert.equal(decision.chosen, 'fast-dear');
    assert.deepEqual(
      decision.ranking.map((r) => [r.candidateId, r.score]),
      [
        ['fast-dear', 600],
        ['slow-cheap', 1100],
      ],
    );
    assert.deepEqual(decision.ranking[0]!.breakdown, { cost: 500, time: 100, resource: 0 });
    assert.match(decision.basis, /fast-dear/);
  });

  it('breaks score ties on candidate id (same input → same decision)', () => {
    const opt = new ExecutionStrategyOptimizer();
    const a = candidate({ id: 'zeta' });
    const b = candidate({ id: 'alpha' });
    assert.equal(opt.evaluate([a, b]).chosen, 'alpha');
    assert.equal(opt.evaluate([b, a]).chosen, 'alpha');
  });

  it('returns chosen=null when every candidate violates a hard constraint', () => {
    const opt = new ExecutionStrategyOptimizer();
    const decision = opt.evaluate([
      candidate({ id: 'x', policyAllowed: false }),
      candidate({ id: 'y', capabilitySatisfied: false }),
    ]);
    assert.equal(decision.chosen, null);
    assert.equal(decision.rejected.length, 2);
    assert.match(decision.basis, /no feasible candidate/);
  });

  it('human override to another feasible candidate is accepted and recorded', () => {
    const opt = new ExecutionStrategyOptimizer();
    const decision = opt.evaluate([
      candidate({ id: 'winner', estimatedCostMinor: 10 }),
      candidate({ id: 'preferred', estimatedCostMinor: 999 }),
    ]);
    assert.equal(decision.chosen, 'winner');
    const result = opt.applyOverride(decision, { candidateId: 'preferred', by: 'tan' });
    assert.deepEqual(result, {
      accepted: true,
      chosen: 'preferred',
      overriddenBy: 'tan',
      originalChosen: 'winner',
    });
  });

  it('human override to a rejected candidate is refused with per-constraint explanation', () => {
    const opt = new ExecutionStrategyOptimizer();
    const decision = opt.evaluate([
      candidate({ id: 'ok' }),
      candidate({
        id: 'bad',
        capabilitySatisfied: false,
        capabilityNote: 'no shell access on host',
        policyAllowed: false,
        policyNote: 'host outside org boundary',
      }),
    ]);
    const result = opt.applyOverride(decision, { candidateId: 'bad', by: 'tan' });
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.candidateId, 'bad');
      assert.match(result.explanation[0]!, /violates hard constraints/);
      assert.ok(result.explanation.some((e) => /capability/.test(e) && /shell access/.test(e)));
      assert.ok(result.explanation.some((e) => /policy/.test(e) && /org boundary/.test(e)));
    }
  });

  it('human override to an unknown candidate is refused', () => {
    const opt = new ExecutionStrategyOptimizer();
    const decision = opt.evaluate([candidate({ id: 'ok' })]);
    const result = opt.applyOverride(decision, { candidateId: 'ghost', by: 'tan' });
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.match(result.explanation[0]!, /not part of this decision/);
    }
  });
});
