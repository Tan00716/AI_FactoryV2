/**
 * onConflictOpened hook — Batch 36 (§81 emission point).
 *
 * The hook fires exactly once, synchronously, when registerDirective
 * creates an OPEN conflict (equal-rank, genuinely incompatible). It
 * never fires for:
 *  - auto-resolved rank-difference conflicts (higher-authority-wins),
 *  - a third directive attaching to an already-open conflict,
 *  - supersedes (same principal updating its own directive).
 * No emission is ever manufactured.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorityConflictRegistry, type AuthorityConflict } from '../src/authority';

describe('onConflictOpened', () => {
  it('fires exactly once when an OPEN conflict is created', () => {
    const seen: AuthorityConflict[] = [];
    const registry = new AuthorityConflictRegistry({
      onConflictOpened: (c) => seen.push(c),
    });
    registry.registerDirective({
      principalId: 'mgr-a',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-1',
      effect: 'ALLOW',
      instruction: 'proceed',
    });
    const { conflict } = registry.registerDirective({
      principalId: 'mgr-b',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-1',
      effect: 'BLOCK',
      instruction: 'stop',
    });
    assert.equal(conflict?.status, 'OPEN');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].conflictId, conflict?.conflictId);
    assert.equal(seen[0].status, 'OPEN');
  });

  it('does not fire for auto-resolved rank-difference conflicts', () => {
    const seen: AuthorityConflict[] = [];
    const registry = new AuthorityConflictRegistry({
      onConflictOpened: (c) => seen.push(c),
    });
    registry.registerDirective({
      principalId: 'mgr-a',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-1',
      effect: 'ALLOW',
      instruction: 'proceed',
    });
    const { conflict } = registry.registerDirective({
      principalId: 'sa-1',
      authorityLevel: 'security_authority',
      targetKind: 'run',
      targetId: 'run-1',
      effect: 'BLOCK',
      instruction: 'stop',
    });
    assert.equal(conflict?.status, 'RESOLVED');
    assert.equal(seen.length, 0);
  });

  it('does not fire again when a directive attaches to an open conflict', () => {
    const seen: AuthorityConflict[] = [];
    const registry = new AuthorityConflictRegistry({
      onConflictOpened: (c) => seen.push(c),
    });
    registry.registerDirective({
      principalId: 'mgr-a',
      authorityLevel: 'manager',
      targetKind: 'task',
      targetId: 'task-1',
      effect: 'PAUSE',
      instruction: 'hold',
    });
    registry.registerDirective({
      principalId: 'mgr-b',
      authorityLevel: 'manager',
      targetKind: 'task',
      targetId: 'task-1',
      effect: 'RESUME',
      instruction: 'go',
    });
    assert.equal(seen.length, 1);
    registry.registerDirective({
      principalId: 'mgr-c',
      authorityLevel: 'manager',
      targetKind: 'task',
      targetId: 'task-1',
      effect: 'CANCEL',
      instruction: 'abort',
    });
    assert.equal(seen.length, 1);
  });

  it('does not fire for supersedes or compatible directives', () => {
    const seen: AuthorityConflict[] = [];
    const registry = new AuthorityConflictRegistry({
      onConflictOpened: (c) => seen.push(c),
    });
    registry.registerDirective({
      principalId: 'mgr-a',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-2',
      effect: 'ALLOW',
      instruction: 'proceed',
    });
    // Same principal updates its own directive → supersede, not conflict.
    const { conflict } = registry.registerDirective({
      principalId: 'mgr-a',
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-2',
      effect: 'ALLOW',
      instruction: 'proceed',
    });
    assert.equal(conflict, null);
    assert.equal(seen.length, 0);
  });
});
