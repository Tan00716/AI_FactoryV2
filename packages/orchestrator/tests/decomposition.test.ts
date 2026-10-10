/**
 * Tests for auto-decomposition (spec §95): template shapes per kind,
 * dependency chains, determinism, constraint folding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decompose, DecompositionInput, DecompositionKind } from '../src/index';

const KINDS: DecompositionKind[] = ['bugfix', 'feature', 'refactor', 'research'];

function inputFor(kind: DecompositionKind): DecompositionInput {
  return {
    title: 'payment success but order stays Pending',
    goal: 'Orders transition to Paid when the payment gateway confirms success',
    kind,
    constraints: ['no schema migration', 'must ship behind feature flag'],
  };
}

describe('decompose', () => {
  for (const kind of KINDS) {
    it(`produces a complete plan for kind=${kind}`, () => {
      const plan = decompose(inputFor(kind));
      assert.ok(plan.goal.length > 0, 'goal');
      assert.ok(plan.acceptanceCriteria.length >= 3, 'acceptance criteria');
      assert.ok(plan.risks.length >= 2, 'risks');
      assert.ok(plan.subtasks.length >= 4, 'subtasks');
      assert.ok(plan.dependencies.length >= 1, 'dependencies');
      assert.ok(plan.requiredSpecialists.length >= 1, 'specialists');
      assert.ok(plan.testStrategy.length > 0, 'test strategy');
      assert.ok(plan.deploymentStrategy.length > 0, 'deployment strategy');
      for (const s of plan.subtasks) {
        assert.ok(s.title.includes('payment success but order stays Pending'));
        assert.ok(s.kind.length > 0);
        assert.ok(s.estimate.length > 0);
      }
    });
  }

  it('bugfix follows investigate → reproduce → fix → tests → regression', () => {
    const plan = decompose(inputFor('bugfix'));
    assert.deepEqual(
      plan.subtasks.map((s) => s.kind),
      ['investigate', 'reproduce', 'fix', 'test', 'regression'],
    );
  });

  it('feature follows design → backend → frontend → integration → qa', () => {
    const plan = decompose(inputFor('feature'));
    assert.equal(plan.subtasks[0]!.kind, 'design');
    assert.ok(plan.subtasks.some((s) => s.title.startsWith('Implement backend')));
    assert.ok(plan.subtasks.some((s) => s.title.startsWith('Implement frontend')));
    assert.ok(plan.subtasks.some((s) => s.title.startsWith('Integrate')));
    assert.equal(plan.subtasks[plan.subtasks.length - 1]!.kind, 'test');
  });

  it('builds a sequential depends_on chain covering all subtasks', () => {
    const plan = decompose(inputFor('bugfix'));
    const n = plan.subtasks.length;
    assert.equal(plan.dependencies.length, n - 1);
    for (let i = 0; i < n - 1; i++) {
      assert.deepEqual(plan.dependencies[i], {
        from: i + 1,
        to: i,
        kind: 'depends_on',
      });
    }
  });

  it('folds constraints into risks', () => {
    const plan = decompose(inputFor('bugfix'));
    assert.ok(plan.risks.some((r) => r.includes('no schema migration')));
    assert.ok(plan.risks.some((r) => r.includes('must ship behind feature flag')));
  });

  it('is deterministic: same input → same plan', () => {
    const a = decompose(inputFor('feature'));
    const b = decompose(inputFor('feature'));
    assert.deepEqual(a, b);
  });

  it('works without optional constraints', () => {
    const plan = decompose({
      title: 'slow dashboard',
      goal: 'make it fast',
      kind: 'refactor',
    });
    assert.ok(plan.subtasks.length > 0);
    assert.ok(plan.risks.every((r) => !r.includes('Constraint')));
  });
});
