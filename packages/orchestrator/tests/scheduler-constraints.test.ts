/**
 * §21.1 unified pre-dispatch gate (G-30): all nine hard constraints are
 * evaluated before a task may be selected; failures come back in
 * structured form from evaluateBatch()/evaluateConstraints(), and
 * nextBatch() never selects a gated-out task.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_CONSTRAINTS,
  HardConstraint,
  Scheduler,
  SchedulableTask,
} from '../src/index';

const NON_DEPENDENCY = HARD_CONSTRAINTS.filter((c) => c !== 'dependency');

function task(over: Partial<SchedulableTask> = {}): SchedulableTask {
  return { id: 't', priority: 'P2', dependsOn: [], ...over };
}

describe('§21.1 hard-constraint gate (G-30)', () => {
  for (const constraint of NON_DEPENDENCY) {
    it(`blocks a task whose ${constraint} constraint is attested false`, () => {
      const s = new Scheduler({ concurrencyLimit: 4 });
      s.enqueue(task({ constraints: { [constraint]: false } }));
      const ev = s.evaluateBatch();
      assert.deepEqual(ev.selected, []);
      assert.equal(ev.blocked.length, 1);
      assert.equal(ev.blocked[0]!.taskId, 't');
      assert.deepEqual(
        ev.blocked[0]!.failures.map((f) => f.constraint),
        [constraint],
      );
      // nextBatch agrees: the gated task is never selected.
      assert.deepEqual(s.nextBatch(), []);
    });
  }

  it('blocks on unmet dependencies and names them', () => {
    const s = new Scheduler({ concurrencyLimit: 4 });
    s.enqueue(task({ id: 'a', dependsOn: ['x', 'y'] }));
    const ev = s.evaluateBatch();
    assert.deepEqual(ev.selected, []);
    assert.equal(ev.blocked[0]!.failures.length, 1);
    assert.equal(ev.blocked[0]!.failures[0]!.constraint, 'dependency');
    assert.match(ev.blocked[0]!.failures[0]!.reason, /x, y/);
  });

  it('reports every failed constraint at once, in spec order', () => {
    let authorityOk = true;
    const s = new Scheduler({
      concurrencyLimit: 4,
      authorityValidator: () => (authorityOk ? null : 'principal suspended'),
    });
    const t = task({
      dependsOn: ['missing'],
      authority: { principal: 'boss' },
      constraints: Object.fromEntries(NON_DEPENDENCY.map((c) => [c, false])),
    });
    s.enqueue(t);
    authorityOk = false; // authority lapses after enqueue
    const failures = s.evaluateConstraints(t);
    assert.deepEqual(
      failures.map((f) => f.constraint),
      [...HARD_CONSTRAINTS],
    );
  });

  it('a checker overrides attestation in both directions', () => {
    const s = new Scheduler({
      concurrencyLimit: 4,
      constraintCheckers: {
        modelAvailability: (t) =>
          t.id === 'needs-down-model' ? 'model m is unavailable' : null,
        budgetReservation: () => null, // live fact: budget is reservable
      },
    });
    // Attested true, checker says no → blocked by the checker.
    s.enqueue(task({ id: 'needs-down-model', constraints: { modelAvailability: true } }));
    // Attested false, checker says yes → passes.
    s.enqueue(task({ id: 'budget-ok', constraints: { budgetReservation: false } }));
    const ev = s.evaluateBatch();
    assert.deepEqual(ev.selected, ['budget-ok']);
    assert.equal(ev.blocked.length, 1);
    assert.equal(ev.blocked[0]!.taskId, 'needs-down-model');
    assert.match(ev.blocked[0]!.failures[0]!.reason, /model m is unavailable/);
  });

  it('strict mode fails closed on unevaluated constraints', () => {
    const s = new Scheduler({ concurrencyLimit: 4, requireAllConstraints: true });
    s.enqueue(task());
    const ev = s.evaluateBatch();
    assert.deepEqual(ev.selected, []);
    const failed = ev.blocked[0]!.failures.map((f) => f.constraint);
    // Every non-dependency constraint is unevaluated; dependency passes
    // (no deps), so exactly the other eight fail.
    assert.deepEqual(failed, [...NON_DEPENDENCY]);
    assert.match(ev.blocked[0]!.failures[0]!.reason, /not evaluated/);
  });

  it('strict mode passes a fully attested task', () => {
    const s = new Scheduler({ concurrencyLimit: 4, requireAllConstraints: true });
    s.enqueue(
      task({
        constraints: Object.fromEntries(NON_DEPENDENCY.map((c) => [c, true])),
      }),
    );
    assert.deepEqual(s.nextBatch(), ['t']);
  });

  it('default mode keeps bare §93-style tasks schedulable (back-compat)', () => {
    const s = new Scheduler({ concurrencyLimit: 4 });
    s.enqueue(task());
    assert.deepEqual(s.nextBatch(), ['t']);
  });

  it('a gated task becomes selectable once its facts are fixed', () => {
    const s = new Scheduler({ concurrencyLimit: 4 });
    s.enqueue(task({ constraints: { capability: false } }));
    assert.deepEqual(s.nextBatch(), []);
    s.enqueue(task({ constraints: { capability: true } }));
    assert.deepEqual(s.nextBatch(), ['t']);
  });

  it('blocked tasks keep their ordering basis for explanation (§21.2)', () => {
    const s = new Scheduler({ concurrencyLimit: 4 });
    s.enqueue(task({ severity: 7, constraints: { isolation: false } }));
    const ev = s.evaluateBatch();
    assert.equal(ev.basis['t']!.severity, 7);
    assert.equal(ev.basis['t']!.priority, 'P2');
    const log = s.decisionLog();
    assert.ok(log.some((e) => e.kind === 'batch' && e.blocked?.length === 1));
  });
});
