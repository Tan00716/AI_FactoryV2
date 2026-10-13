/**
 * Tests for §8.1 / INV-31 authority conflict arbitration.
 *
 * The honest contract:
 *  - no real conflict → never triggers;
 *  - Security Authority BLOCK beats ordinary Manager ALLOW (the spec's
 *    explicit case) via the general higher-authority-wins rule;
 *  - two equally-valid incompatible directives → pause + escalate,
 *    never last-command-wins;
 *  - escalation goes strictly upward.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorityConflictRegistry,
  type AuthorityAuditEvent,
} from '../src/index';

function makeRegistry() {
  const events: AuthorityAuditEvent[] = [];
  let t = 1_700_000_000_000;
  let n = 0;
  const reg = new AuthorityConflictRegistry({
    audit: (e) => events.push(e),
    now: () => t++,
    newId: () => `t${++n}`,
  });
  return { reg, events };
}

const dir = (
  principalId: string,
  authorityLevel: 'owner' | 'security_authority' | 'manager' | 'operator' | 'viewer',
  effect: 'ALLOW' | 'BLOCK' | 'PAUSE' | 'RESUME' | 'CANCEL',
  targetId = 'run-1',
) => ({
  principalId,
  authorityLevel,
  targetKind: 'run' as const,
  targetId,
  effect,
  instruction: `${effect} ${targetId}`,
});

describe('registerDirective — no real conflict never triggers', () => {
  it('single directive: no conflict', () => {
    const { reg } = makeRegistry();
    const r = reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    assert.equal(r.conflict, null);
    assert.equal(reg.isPaused('run', 'run-1'), false);
    assert.equal(r.directive.status, 'ACTIVE');
  });

  it('two identical-effect directives from different principals: no conflict', () => {
    const { reg } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'BLOCK'));
    const r = reg.registerDirective(dir('mgr-2', 'manager', 'BLOCK'));
    assert.equal(r.conflict, null);
    assert.equal(reg.isPaused('run', 'run-1'), false);
  });

  it('BLOCK + PAUSE from different principals: compatible, no conflict', () => {
    const { reg } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'BLOCK'));
    const r = reg.registerDirective(dir('mgr-2', 'manager', 'PAUSE'));
    assert.equal(r.conflict, null);
  });

  it('conflicts on different targets do not interact', () => {
    const { reg } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW', 'run-1'));
    const r = reg.registerDirective(dir('mgr-2', 'manager', 'BLOCK', 'run-2'));
    assert.equal(r.conflict, null);
    assert.equal(reg.isPaused('run', 'run-1'), false);
    assert.equal(reg.isPaused('run', 'run-2'), false);
  });
});

describe('§8.1 explicit rule — Security Authority BLOCK over Manager ALLOW', () => {
  it('auto-resolves: BLOCK wins, no pause, audit cites the rule', () => {
    const { reg, events } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    const r = reg.registerDirective(dir('sec-1', 'security_authority', 'BLOCK'));
    assert.ok(r.conflict);
    assert.equal(r.conflict.status, 'RESOLVED');
    assert.equal(r.conflict.resolution?.mode, 'auto_rule');
    assert.equal(r.conflict.resolution?.rule, 'higher-authority-wins');
    assert.equal(r.conflict.resolution?.winningDirectiveId, r.directive.directiveId);
    // The target was never paused: the deterministic rule decided immediately.
    assert.equal(reg.isPaused('run', 'run-1'), false);
    // The losing directive is marked overridden, not silently deleted.
    assert.equal(reg.getDirective(r.directive.directiveId)?.status, 'ACTIVE');
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes('AUTHORITY_CONFLICT_DETECTED'));
    assert.ok(kinds.includes('AUTHORITY_CONFLICT_AUTO_RESOLVED'));
  });

  it('order does not matter: BLOCK first, then lower ALLOW still loses', () => {
    const { reg } = makeRegistry();
    const block = reg.registerDirective(dir('sec-1', 'security_authority', 'BLOCK'));
    const r = reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    assert.ok(r.conflict);
    assert.equal(r.conflict.status, 'RESOLVED');
    assert.equal(r.conflict.resolution?.winningDirectiveId, block.directive.directiveId);
  });
});

describe('equal-rank incompatible directives → AUTHORITY_CONFLICT, pause, escalate', () => {
  it('manager ALLOW vs manager BLOCK: paused, both recorded, never last-wins', () => {
    const { reg, events } = makeRegistry();
    const first = reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    assert.equal(first.conflict, null);
    const r = reg.registerDirective(dir('mgr-2', 'manager', 'BLOCK'));
    assert.ok(r.conflict);
    assert.equal(r.conflict.status, 'OPEN');
    assert.deepEqual(
      [...r.conflict.directiveIds].sort(),
      [first.directive.directiveId, r.directive.directiveId].sort(),
    );
    // Paused: related actions must halt.
    assert.equal(reg.isPaused('run', 'run-1'), true);
    // Not last-command-wins: the later directive does not auto-govern.
    assert.equal(r.conflict.resolution, undefined);
    const detected = events.find((e) => e.event === 'AUTHORITY_CONFLICT_DETECTED');
    assert.ok(detected);
    assert.match(String(detected.details['escalation'] ?? ''), /higher-ranked/);
  });

  it('a third directive on a paused target is attached, pause unchanged', () => {
    const { reg } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    const c = reg.registerDirective(dir('mgr-2', 'manager', 'BLOCK')).conflict!;
    const r = reg.registerDirective(dir('mgr-3', 'manager', 'CANCEL'));
    assert.equal(r.conflict?.conflictId, c.conflictId);
    assert.equal(reg.isPaused('run', 'run-1'), true);
    assert.ok(reg.getConflict(c.conflictId)?.directiveIds.includes(r.directive.directiveId));
  });

  it('same principal updating its own directive: supersede, not a conflict', () => {
    const { reg } = makeRegistry();
    const first = reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    const r = reg.registerDirective(dir('mgr-1', 'manager', 'BLOCK'));
    assert.equal(r.conflict, null);
    assert.equal(r.superseded?.directiveId, first.directive.directiveId);
    assert.equal(reg.getDirective(first.directive.directiveId)?.status, 'SUPERSEDED');
    assert.equal(reg.isPaused('run', 'run-1'), false);
  });
});

describe('human escalation — strictly upward', () => {
  function openConflict() {
    const { reg, events } = makeRegistry();
    reg.registerDirective(dir('mgr-1', 'manager', 'ALLOW'));
    const r = reg.registerDirective(dir('mgr-2', 'manager', 'BLOCK'));
    return { reg, events, conflict: r.conflict! };
  }

  it('owner resolves: pause lifted, audit recorded', () => {
    const { reg, events, conflict } = openConflict();
    const cid = conflict.conflictId;
    const res = reg.resolveConflict(cid, {
      decidedByPrincipalId: 'owner-1',
      decidedByLevel: 'owner',
      winningDirectiveId: conflict.directiveIds[0],
      rationale: 'business priority: proceed',
    });
    assert.equal(res.ok, true);
    assert.equal(reg.isPaused('run', 'run-1'), false);
    if (res.ok) assert.equal(res.conflict.resolution?.mode, 'human');
    assert.ok(events.some((e) => e.event === 'AUTHORITY_CONFLICT_HUMAN_RESOLVED'));
  });

  it('sideways decider (manager) is refused', () => {
    const { reg, conflict } = openConflict();
    const res = reg.resolveConflict(conflict.conflictId, {
      decidedByPrincipalId: 'mgr-9',
      decidedByLevel: 'manager',
      winningDirectiveId: conflict.directiveIds[0],
      rationale: 'i say so',
    });
    assert.equal(res.ok, false);
    assert.equal(reg.isPaused('run', 'run-1'), true);
  });

  it('downward decider (operator) is refused', () => {
    const { reg, conflict } = openConflict();
    const res = reg.resolveConflict(conflict.conflictId, {
      decidedByPrincipalId: 'op-1',
      decidedByLevel: 'operator',
      winningDirectiveId: conflict.directiveIds[0],
      rationale: 'nope',
    });
    assert.equal(res.ok, false);
  });

  it('unknown conflict and non-member winner are refused', () => {
    const { reg, conflict } = openConflict();
    assert.equal(reg.resolveConflict('ac-nope', {
      decidedByPrincipalId: 'owner-1', decidedByLevel: 'owner',
      winningDirectiveId: 'dir-t9', rationale: 'x',
    }).ok, false);
    assert.equal(reg.resolveConflict(conflict.conflictId, {
      decidedByPrincipalId: 'owner-1', decidedByLevel: 'owner',
      winningDirectiveId: 'dir-t999', rationale: 'x',
    }).ok, false);
  });

  it('already-resolved conflict cannot be re-resolved', () => {
    const { reg, conflict } = openConflict();
    const first = reg.resolveConflict(conflict.conflictId, {
      decidedByPrincipalId: 'owner-1', decidedByLevel: 'owner',
      winningDirectiveId: conflict.directiveIds[0], rationale: 'done',
    });
    assert.equal(first.ok, true);
    const second = reg.resolveConflict(conflict.conflictId, {
      decidedByPrincipalId: 'owner-1', decidedByLevel: 'owner',
      winningDirectiveId: conflict.directiveIds[1], rationale: 'change mind',
    });
    assert.equal(second.ok, false);
  });
});

describe('validation', () => {
  it('rejects unknown level/effect/target', () => {
    const { reg } = makeRegistry();
    assert.throws(() =>
      reg.registerDirective({ ...dir('a', 'manager', 'ALLOW'), authorityLevel: 'czar' as never }),
    );
    assert.throws(() =>
      reg.registerDirective({ ...dir('a', 'manager', 'ALLOW'), effect: 'NUKE' as never }),
    );
    assert.throws(() =>
      reg.registerDirective({ ...dir('a', 'manager', 'ALLOW'), targetKind: 'server' as never }),
    );
    assert.throws(() =>
      reg.registerDirective({ ...dir('a', 'manager', 'ALLOW'), principalId: '' }),
    );
  });
});
