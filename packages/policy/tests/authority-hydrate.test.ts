/**
 * Registry boot hydrate — §8.1, Batch 75 (F12).
 *
 * The honest contract:
 *  - hydrate loads persisted directives + conflicts into a fresh
 *    registry: OPEN conflicts pause their targets again, RESOLVED
 *    conflicts are read-only history;
 *  - hydrate is SILENT: no audit events, and onConflictOpened never
 *    fires — a restart must not re-raise the §81 needsHuman upgrade;
 *  - hydrate is boot-only: it throws on a non-empty registry;
 *  - the default id generator continues past hydrated `id-N`
 *    suffixes, so post-hydrate ids never collide;
 *  - corrupt shapes throw loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorityConflictRegistry,
  type AuthorityAuditEvent,
  type AuthorityConflict,
  type Directive,
} from '../src/index';

const TARGET = 'run-hyd-1';

function makeRegistry(events: AuthorityAuditEvent[], opened: AuthorityConflict[]) {
  return new AuthorityConflictRegistry({
    audit: (e) => events.push(e),
    onConflictOpened: (c) => opened.push(c),
  });
}

function openConflictShapes(): { directives: Directive[]; conflicts: AuthorityConflict[] } {
  const events: AuthorityAuditEvent[] = [];
  const opened: AuthorityConflict[] = [];
  const r = makeRegistry(events, opened);
  r.registerDirective({
    principalId: 'mgr-a',
    authorityLevel: 'manager',
    targetKind: 'run',
    targetId: TARGET,
    effect: 'ALLOW',
    instruction: 'proceed',
  });
  const { conflict } = r.registerDirective({
    principalId: 'mgr-b',
    authorityLevel: 'manager',
    targetKind: 'run',
    targetId: TARGET,
    effect: 'BLOCK',
    instruction: 'halt',
  });
  assert.ok(conflict);
  assert.equal(conflict.status, 'OPEN');
  // Resolve a second conflict so hydrate also covers history rows.
  r.registerDirective({
    principalId: 'mgr-a',
    authorityLevel: 'manager',
    targetKind: 'run',
    targetId: 'run-hyd-2',
    effect: 'ALLOW',
    instruction: 'proceed',
  });
  const second = r.registerDirective({
    principalId: 'mgr-b',
    authorityLevel: 'manager',
    targetKind: 'run',
    targetId: 'run-hyd-2',
    effect: 'BLOCK',
    instruction: 'halt',
  });
  assert.ok(second.conflict);
  const resolved = r.resolveConflict(second.conflict.conflictId, {
    decidedByPrincipalId: 'owner-1',
    decidedByLevel: 'owner',
    winningDirectiveId: second.conflict.directiveIds[0],
    rationale: 'owner picks ALLOW',
  });
  assert.equal(resolved.ok, true);
  return {
    directives: r.listDirectives(),
    conflicts: r.listConflicts(),
  };
}

describe('AuthorityConflictRegistry.hydrate', () => {
  it('loads directives + conflicts; OPEN pauses the target again', () => {
    const { directives, conflicts } = openConflictShapes();
    const events: AuthorityAuditEvent[] = [];
    const opened: AuthorityConflict[] = [];
    const r = makeRegistry(events, opened);
    r.hydrate(directives, conflicts);

    const open = r.listConflicts('OPEN');
    assert.equal(open.length, 1);
    assert.equal(open[0].targetId, TARGET);
    assert.deepEqual(open[0].directiveIds, conflicts.find((c) => c.status === 'OPEN')!.directiveIds);
    assert.equal(r.isPaused('run', TARGET), true);

    const got = r.getConflict(open[0].conflictId);
    assert.ok(got);
    assert.equal(got.status, 'OPEN');
    for (const id of got.directiveIds) {
      assert.ok(r.getDirective(id));
    }

    const resolved = r.listConflicts('RESOLVED');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolution?.mode, 'human');

    // Targets endpoint parity: paused flag + open conflict + directives.
    assert.equal(r.listDirectives('run', TARGET).length, 2);
  });

  it('is silent: no audit events, no onConflictOpened', () => {
    const { directives, conflicts } = openConflictShapes();
    const events: AuthorityAuditEvent[] = [];
    const opened: AuthorityConflict[] = [];
    const r = makeRegistry(events, opened);
    r.hydrate(directives, conflicts);
    assert.deepEqual(events, []);
    assert.deepEqual(opened, []);
  });

  it('throws on a non-empty registry (boot-only)', () => {
    const { directives, conflicts } = openConflictShapes();
    const r = new AuthorityConflictRegistry();
    r.registerDirective({
      principalId: 'x',
      authorityLevel: 'viewer',
      targetKind: 'run',
      targetId: 'run-other',
      effect: 'ALLOW',
      instruction: '',
    });
    assert.throws(() => r.hydrate(directives, conflicts), /boot-only/);
  });

  it('continues the id sequence past hydrated ids (no collision)', () => {
    const { directives, conflicts } = openConflictShapes();
    const r = new AuthorityConflictRegistry();
    r.hydrate(directives, conflicts);
    const seen = new Set([
      ...directives.map((d) => d.directiveId),
      ...conflicts.map((c) => c.conflictId),
    ]);
    const { directive, conflict } = r.registerDirective({
      principalId: 'mgr-c',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-hyd-3',
      effect: 'ALLOW',
      instruction: 'proceed',
    });
    assert.ok(!seen.has(directive.directiveId), `id collision: ${directive.directiveId}`);
    assert.equal(conflict, null);
    const second = r.registerDirective({
      principalId: 'mgr-d',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-hyd-3',
      effect: 'BLOCK',
      instruction: 'halt',
    });
    assert.ok(second.conflict);
    assert.ok(!seen.has(second.conflict.conflictId), `id collision: ${second.conflict.conflictId}`);
    assert.ok(!seen.has(second.directive.directiveId));
  });

  it('corrupt shapes throw loudly', () => {
    const r = new AuthorityConflictRegistry();
    const bad = { ...openConflictShapes().directives[0], status: 'BOGUS' } as unknown as Directive;
    assert.throws(() => r.hydrate([bad], []), /corrupt/);
    const r2 = new AuthorityConflictRegistry();
    const badC = { ...openConflictShapes().conflicts[0], status: 'BOGUS' } as unknown as AuthorityConflict;
    assert.throws(() => r2.hydrate([], [badC]), /corrupt/);
  });

  it('hydrated rows are copies: mutating inputs afterwards does not affect the registry', () => {
    const { directives, conflicts } = openConflictShapes();
    const r = new AuthorityConflictRegistry();
    r.hydrate(directives, conflicts);
    directives[0].status = 'OVERRIDDEN';
    conflicts[0].directiveIds.push('dir-evil');
    const back = r.getDirective(directives[0].directiveId);
    assert.equal(back?.status, 'ACTIVE');
    assert.ok(!r.getConflict(conflicts[0].conflictId)?.directiveIds.includes('dir-evil'));
  });
});
