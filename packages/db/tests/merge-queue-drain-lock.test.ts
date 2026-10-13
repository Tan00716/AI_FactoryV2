/**
 * Merge Queue drain lock — SPEC v2 §36 (Batch 23).
 *
 * One lease row per repo in `merge_queue_drain_locks`: only one drainer
 * per repo at a time across processes sharing the DB file. These tests
 * pin the lease semantics against a real SQLite file:
 *  - acquire → 'acquired'; a second holder while the heartbeat is
 *    fresh → 'contested';
 *  - release is holder-conditional (a stranger cannot release);
 *  - a stale heartbeat → 'takeover', and two racing takeovers cannot
 *    both win (single conditional UPDATE);
 *  - heartbeat refresh keeps a slow holder alive; a non-holder's
 *    heartbeat reports false.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../src/schema';
import { SqliteMergeQueueDrainLock } from '../src/merge-queue';

const TTL = 60_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeLock(): { db: DatabaseSync; lock: SqliteMergeQueueDrainLock; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'mq-drain-lock-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 't.db'));
  db.exec(SCHEMA);
  return { db, lock: new SqliteMergeQueueDrainLock(db), close: () => db.close() };
}

describe('SqliteMergeQueueDrainLock', () => {
  it('acquire → contested → release → acquire', () => {
    const { lock, close } = makeLock();
    try {
      assert.equal(lock.drainState('r'), null);
      assert.equal(lock.acquireDrain('r', 'holder-a', 1_000, TTL), 'acquired');
      const st = lock.drainState('r');
      assert.equal(st?.holderId, 'holder-a');
      assert.equal(st?.heartbeatAt, 1_000);
      // Live heartbeat: a second holder is contested, not queued behind.
      assert.equal(lock.acquireDrain('r', 'holder-b', 2_000, TTL), 'contested');
      assert.equal(lock.drainState('r')?.holderId, 'holder-a');
      // A stranger cannot release the lease.
      lock.releaseDrain('r', 'holder-b');
      assert.equal(lock.drainState('r')?.holderId, 'holder-a');
      lock.releaseDrain('r', 'holder-a');
      assert.equal(lock.drainState('r'), null);
      assert.equal(lock.acquireDrain('r', 'holder-b', 3_000, TTL), 'acquired');
    } finally {
      close();
    }
  });

  it('a stale heartbeat allows takeover, but only one contender wins', () => {
    const { lock, close } = makeLock();
    try {
      assert.equal(lock.acquireDrain('r', 'dead', 1_000, TTL), 'acquired');
      // Heartbeat 1000, now 1000+TTL+1 → stale.
      const winner = lock.acquireDrain('r', 'new-a', 1_000 + TTL + 1, TTL);
      assert.equal(winner, 'takeover');
      assert.equal(lock.drainState('r')?.holderId, 'new-a');
      // A racing contender that observed the same stale heartbeat loses
      // the conditional UPDATE… but its own heartbeat is fresh now, so
      // it is contested rather than taking over again.
      assert.equal(lock.acquireDrain('r', 'new-b', 1_000 + TTL + 2, TTL), 'contested');
    } finally {
      close();
    }
  });

  it('two holders racing a stale lock: exactly one takes over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-drain-lock-race-'));
    dirs.push(dir);
    const file = join(dir, 't.db');
    const mk = () => {
      const db = new DatabaseSync(file);
      db.exec(SCHEMA);
      return { db, lock: new SqliteMergeQueueDrainLock(db) };
    };
    const a = mk();
    const b = mk();
    try {
      assert.equal(a.lock.acquireDrain('r', 'dead', 1_000, TTL), 'acquired');
      a.db.close();
      // Both contenders observe the same stale heartbeat; the
      // conditional UPDATE lets exactly one win.
      const results = [
        b.lock.acquireDrain('r', 'racer-1', 1_000 + TTL + 5, TTL),
        b.lock.acquireDrain('r', 'racer-2', 1_000 + TTL + 5, TTL),
      ].sort();
      assert.deepEqual(results, ['contested', 'takeover']);
    } finally {
      b.db.close();
    }
  });

  it('heartbeat refresh keeps a slow holder alive; strangers report false', () => {
    const { lock, close } = makeLock();
    try {
      assert.equal(lock.acquireDrain('r', 'slow', 1_000, TTL), 'acquired');
      assert.equal(lock.heartbeatDrain('r', 'slow', 1_000 + TTL - 1), true);
      // Refreshed at TTL-1: still live at TTL+TTL-2.
      assert.equal(lock.acquireDrain('r', 'other', 1_000 + 2 * TTL - 2, TTL), 'contested');
      // Stranger heartbeat does not extend the lease.
      assert.equal(lock.heartbeatDrain('r', 'intruder', 1_000 + 2 * TTL - 1), false);
      // Past the refreshed heartbeat + TTL: takeover allowed.
      assert.equal(lock.acquireDrain('r', 'other', 1_000 + 3 * TTL, TTL), 'takeover');
    } finally {
      close();
    }
  });

  it('locks are per-repo: draining repo A never blocks repo B', () => {
    const { lock, close } = makeLock();
    try {
      assert.equal(lock.acquireDrain('repo-a', 'h1', 1_000, TTL), 'acquired');
      assert.equal(lock.acquireDrain('repo-b', 'h2', 1_000, TTL), 'acquired');
      lock.releaseDrain('repo-a', 'h1');
      lock.releaseDrain('repo-b', 'h2');
    } finally {
      close();
    }
  });
});
