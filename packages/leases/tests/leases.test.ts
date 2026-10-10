/**
 * Lease manager tests — SPEC v2 §22.3.
 * Deterministic clock: time only moves when the test says so.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LeaseConflictError,
  LeaseManager,
  LeaseNotFoundError,
  ResourceLockManager,
  StaleOwnerError,
} from '../src/index';

describe('LeaseManager — single writer + fencing', () => {
  let t: number;
  let mgr: LeaseManager;
  beforeEach(() => {
    t = 1_700_000_000_000;
    mgr = new LeaseManager({ now: () => t });
  });

  it('acquire gives one valid writer; second acquire conflicts', () => {
    const l1 = mgr.acquire('ws:project-a', 'run-A', 60_000);
    assert.equal(l1.generation, 1);
    assert.equal(l1.fencing_token, 1);
    assert.equal(l1.owner_run_id, 'run-A');
    assert.throws(() => mgr.acquire('ws:project-a', 'run-B', 60_000), LeaseConflictError);
  });

  it('validate() passes for the current owner at the final execution point', () => {
    const l = mgr.acquire('ws:project-a', 'run-A', 60_000);
    const v = mgr.validate('ws:project-a', l.fencing_token);
    assert.equal(v.owner_run_id, 'run-A');
  });

  it('expired lease → STALE_OWNER, and the resource becomes acquirable', () => {
    const l = mgr.acquire('ws:project-a', 'run-A', 1_000);
    t += 2_000;
    assert.throws(() => mgr.validate('ws:project-a', l.fencing_token), StaleOwnerError);
    const l2 = mgr.acquire('ws:project-a', 'run-B', 60_000);
    assert.equal(l2.owner_run_id, 'run-B');
  });

  it('reassign bumps generation AND fencing_token; old token is STALE_OWNER', () => {
    const l1 = mgr.acquire('ws:project-a', 'run-A', 60_000);
    const l2 = mgr.reassign('ws:project-a', 'run-B', 60_000);
    assert.equal(l2.generation, l1.generation + 1);
    assert.equal(l2.fencing_token, l1.fencing_token + 1);
    // The late write from run-A — even though run-A "finished" — is refused.
    assert.throws(
      () => mgr.validate('ws:project-a', l1.fencing_token),
      (err: unknown) => err instanceof StaleOwnerError && err.reasonCode === 'STALE_OWNER',
    );
    // New owner writes fine.
    assert.equal(mgr.validate('ws:project-a', l2.fencing_token).owner_run_id, 'run-B');
  });

  it('renew extends expiry and bumps renew_sequence; wrong token is stale', () => {
    const l = mgr.acquire('ws:project-a', 'run-A', 1_000);
    const r = mgr.renew(l.id, l.fencing_token, 60_000);
    assert.equal(r.renew_sequence, 1);
    t += 2_000; // past the ORIGINAL expiry, inside the renewed one
    assert.doesNotThrow(() => mgr.validate('ws:project-a', r.fencing_token));
    assert.throws(() => mgr.renew(l.id, 999, 60_000), StaleOwnerError);
  });

  it('release frees the resource; wrong token cannot release', () => {
    const l = mgr.acquire('ws:project-a', 'run-A', 60_000);
    assert.throws(() => mgr.release(l.id, 999), StaleOwnerError);
    mgr.release(l.id, l.fencing_token);
    assert.equal(mgr.get('ws:project-a'), undefined);
    assert.throws(() => mgr.release(l.id, l.fencing_token), LeaseNotFoundError);
  });

  it('fencing is monotonic across multiple reassignments', () => {
    mgr.acquire('ws:x', 'run-A', 60_000);
    const tokens: number[] = [];
    for (const owner of ['run-B', 'run-C', 'run-D']) {
      tokens.push(mgr.reassign('ws:x', owner, 60_000).fencing_token);
    }
    assert.deepEqual(tokens, [2, 3, 4]);
    assert.throws(() => mgr.validate('ws:x', 1), StaleOwnerError);
    assert.throws(() => mgr.validate('ws:x', 3), StaleOwnerError);
    assert.equal(mgr.validate('ws:x', 4).owner_run_id, 'run-D');
  });
});

describe('ResourceLockManager — ordered locks (§22.2)', () => {
  let t: number;
  let locks: ResourceLockManager;
  beforeEach(() => {
    t = 1_700_000_000_000;
    locks = new ResourceLockManager({ now: () => t });
  });

  it('one deployment per project/env: second deployer waits/fails', () => {
    locks.acquire('deployment', 'myproj:prod', 'run-A', 60_000);
    assert.throws(
      () => locks.acquire('deployment', 'myproj:prod', 'run-B', 60_000),
      /could not acquire locks in time/,
    );
    assert.ok(locks.release('deployment', 'myproj:prod', 'run-A'));
    assert.doesNotThrow(() => locks.acquire('deployment', 'myproj:prod', 'run-B', 60_000));
  });

  it('acquireAll sorts by global order and rolls back on conflict', () => {
    // Reverse-order request must still acquire in (kind rank, key) order.
    const grants = locks.acquireAll([
      { kind: 'file', key: '/ws/a.ts', owner: 'run-A', ttlMs: 60_000 },
      { kind: 'task', key: 'TASK-1', owner: 'run-A', ttlMs: 60_000 },
    ]);
    assert.deepEqual(
      grants.map((g) => g.kind),
      ['task', 'file'],
    );
    // Conflicting multi-acquire releases partial holdings.
    locks.acquire('branch', 'main', 'run-B', 60_000);
    assert.throws(() =>
      locks.acquireAll([
        { kind: 'file', key: '/ws/b.ts', owner: 'run-C', ttlMs: 60_000 },
        { kind: 'branch', key: 'main', owner: 'run-C', ttlMs: 60_000 },
      ]),
    );
    assert.equal(locks.holder('file', '/ws/b.ts'), undefined, 'partial holding rolled back');
  });

  it('expired locks are pruned and re-acquirable', () => {
    locks.acquire('environment', 'prod', 'run-A', 1_000);
    t += 2_000;
    assert.equal(locks.holder('environment', 'prod'), undefined);
    assert.doesNotThrow(() => locks.acquire('environment', 'prod', 'run-B', 60_000));
  });
});
