/**
 * @ai-factory/evaluation — automatic governance unit tests (spec §45.4 / INV-28).
 *
 * Pins the pure policy function `evaluateAutoGovernance` and the
 * `VersionRegistry`: decision rules, idempotency, the hard negative
 * (never auto-escalate on high scores — no decision variant can grant
 * privileges or remove Human decisions), and disable effect records.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAutoGovernance,
  VersionRegistry,
  type AutoGovernanceAction,
  type AutoGovernanceInput,
} from '../src/index';

const ALLOWED_ACTIONS: ReadonlySet<AutoGovernanceAction> = new Set([
  'downgrade-autonomy',
  'disable-version',
  'switch-to-fallback',
]);

function makeClock() {
  let t = 5000;
  return { now: () => (t += 1) };
}

function input(over: Partial<AutoGovernanceInput> = {}): AutoGovernanceInput {
  return {
    version: 'v2',
    scopeEmployees: ['emp-a'],
    observations: [],
    approvedFallbacks: [],
    disabledVersions: [],
    ...over,
  };
}

function obs(successes: boolean[]) {
  return successes.map((success, i) => ({ at: 1000 + i, success }));
}

describe('evaluateAutoGovernance — §45.4 decision rules', () => {
  it('one failing canary observation disables the version (no downgrade yet)', () => {
    const decisions = evaluateAutoGovernance(
      input({ observations: obs([true, false]) }),
      makeClock(),
    );
    const actions = decisions.map((d) => d.action);
    assert.deepEqual(actions, ['disable-version']);
    const [d] = decisions;
    assert.equal(d.version, 'v2');
    assert.match(d.reason, /defective/);
    assert.ok(Number.isFinite(d.at));
  });

  it('two consecutive failing observations also downgrade autonomy', () => {
    const decisions = evaluateAutoGovernance(
      input({ observations: obs([true, false, false]) }),
      makeClock(),
    );
    const actions = decisions.map((d) => d.action).sort();
    assert.deepEqual(actions, ['disable-version', 'downgrade-autonomy']);
    const dg = decisions.find((d) => d.action === 'downgrade-autonomy')!;
    assert.deepEqual(dg.scopeEmployees, ['emp-a']);
  });

  it('non-consecutive failures disable but do not downgrade', () => {
    const decisions = evaluateAutoGovernance(
      input({ observations: obs([false, true, false]) }),
      makeClock(),
    );
    assert.deepEqual(decisions.map((d) => d.action), ['disable-version']);
  });

  it('failed independent eval disables and downgrades even with no observations', () => {
    const decisions = evaluateAutoGovernance(
      input({ independentEval: { passed: false } }),
      makeClock(),
    );
    const actions = decisions.map((d) => d.action).sort();
    assert.deepEqual(actions, ['disable-version', 'downgrade-autonomy']);
  });

  it('disabled version + approved fallback switches to the first active approved fallback', () => {
    const decisions = evaluateAutoGovernance(
      input({
        observations: obs([false, false]),
        approvedFallbacks: ['v0', 'v1'],
      }),
      makeClock(),
    );
    const sw = decisions.find((d) => d.action === 'switch-to-fallback')!;
    assert.equal(sw.targetVersion, 'v0');
    assert.match(sw.reason, /approved fallback v0/);
  });

  it('already-disabled version is never disabled twice, but can still switch', () => {
    const decisions = evaluateAutoGovernance(
      input({
        observations: obs([false]),
        disabledVersions: ['v2'],
        approvedFallbacks: ['v0'],
      }),
      makeClock(),
    );
    const actions = decisions.map((d) => d.action);
    assert.ok(!actions.includes('disable-version'), 'must not double-disable');
    assert.deepEqual(actions, ['switch-to-fallback']);
  });

  it('the caller-filtered fallback list is honoured (switch goes to v1 when v1 is passed)', () => {
    // The policy function does not itself know which fallbacks are
    // disabled — the caller (ImprovementLoop.autoGovern) only passes
    // ACTIVE approved fallbacks. This pins the honoured behaviour.
    const decisions = evaluateAutoGovernance(
      input({
        observations: obs([false]),
        approvedFallbacks: ['v1'],
        disabledVersions: ['v2'],
      }),
      makeClock(),
    );
    assert.equal(
      decisions.find((d) => d.action === 'switch-to-fallback')?.targetVersion,
      'v1',
    );
  });

  it('no switch when already on a fallback version', () => {
    const decisions = evaluateAutoGovernance(
      input({
        observations: obs([false]),
        approvedFallbacks: ['v0'],
        disabledVersions: ['v2'],
        alreadyOnFallback: true,
      }),
      makeClock(),
    );
    assert.ok(!decisions.some((d) => d.action === 'switch-to-fallback'));
  });

  it('no second downgrade for an already-downgraded scope', () => {
    const decisions = evaluateAutoGovernance(
      input({
        observations: obs([false, false]),
        autonomyAlreadyDowngraded: true,
      }),
      makeClock(),
    );
    const actions = decisions.map((d) => d.action);
    assert.ok(!actions.includes('downgrade-autonomy'));
    assert.ok(actions.includes('disable-version'));
  });

  it('excellent results yield ZERO decisions — never auto-escalate on high scores', () => {
    const decisions = evaluateAutoGovernance(
      input({ observations: obs([true, true, true, true]) }),
      makeClock(),
    );
    assert.deepEqual(decisions, []);
  });

  it('no decision variant can grant privileges or remove human decisions', () => {
    // Battery over many inputs: every emitted action must be one of the
    // three allowed governance actions. There is no GRANT_ADMIN /
    // REMOVE_HUMAN variant in the type, and this pins it behaviourally.
    const battery: AutoGovernanceInput[] = [
      input({ observations: obs([false]) }),
      input({ observations: obs([false, false]), approvedFallbacks: ['v0'] }),
      input({ observations: obs([true, true, true]) }),
      input({ independentEval: { passed: false }, observations: obs([true]) }),
      input({ independentEval: { passed: true }, observations: obs([true, false]) }),
    ];
    for (const bi of battery) {
      for (const d of evaluateAutoGovernance(bi, makeClock())) {
        assert.ok(ALLOWED_ACTIONS.has(d.action), `unexpected action: ${d.action}`);
        assert.ok(!/admin|privilege|human.*remov|escalat/i.test(d.reason));
      }
    }
  });

  it('reason strings are deterministic and carry no secret values', () => {
    const a = evaluateAutoGovernance(input({ observations: obs([false]) }), makeClock());
    assert.match(a[0].reason, /v2/);
    assert.ok(!a[0].reason.includes('token'));
  });
});

describe('VersionRegistry — status, approval, disable effect records', () => {
  it('register → approve → disable lifecycle with retained effect record', () => {
    const clock = makeClock();
    const reg = new VersionRegistry({ now: clock.now });
    reg.register('v2');
    assert.equal(reg.isDisabled('v2'), false);
    assert.equal(reg.isApproved('v2'), false);

    reg.approve('v2');
    assert.equal(reg.isApproved('v2'), true);

    const rec = reg.disable('v2', {
      by: 'auto-governance',
      reason: 'v2 defective: 2 failing observation(s)',
      effectRecord: 'failing observations: #1@1001:canary crash; #2@1002:canary crash',
    });
    assert.equal(rec.status, 'DISABLED');
    assert.equal(rec.disabledBy, 'auto-governance');
    assert.equal(rec.approved, true); // approval flag survives disable
    assert.match(rec.effectRecord!, /canary crash/);
    assert.ok(reg.isDisabled('v2'));

    const again = reg.record('v2')!;
    assert.equal(again.status, 'DISABLED');
    assert.match(again.effectRecord!, /canary crash/); // effect record retained
  });

  it('disabling twice is a no-op (idempotent)', () => {
    const reg = new VersionRegistry({ now: makeClock().now });
    const first = reg.disable('v9', { by: 'a', reason: 'r1', effectRecord: 'e1' });
    const second = reg.disable('v9', { by: 'b', reason: 'r2', effectRecord: 'e2' });
    assert.equal(second.disabledBy, 'a');
    assert.equal(second.disableReason, 'r1');
    assert.equal(second.effectRecord, 'e1');
    assert.equal(first.disabledAt, second.disabledAt);
  });

  it('records are copies — callers cannot mutate registry state', () => {
    const reg = new VersionRegistry({ now: makeClock().now });
    reg.register('v3');
    const rec = reg.record('v3')!;
    (rec as { status: string }).status = 'DISABLED';
    assert.equal(reg.isDisabled('v3'), false);
  });

  it('unknown versions are not disabled by default', () => {
    const reg = new VersionRegistry({ now: makeClock().now });
    assert.equal(reg.isDisabled('never-seen'), false);
    assert.equal(reg.record('never-seen'), undefined);
  });
});
