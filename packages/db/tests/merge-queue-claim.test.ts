/**
 * Merge-queue drain claims — SPEC v2 §36 (Batch 23).
 *
 * Two processes draining one repo's queue must not merge the same
 * entry twice. tryClaim() is a single atomic UPDATE … WHERE: exactly
 * one claimant wins. Pinned here:
 *  - first claimant wins, second loses (same DB file, two connections);
 *  - the owner may re-claim its own row (idempotent);
 *  - a claim older than the TTL is stealable (crashed holder);
 *  - a fresh foreign claim is not stealable;
 *  - terminal rows (MERGED/FAILED) are never claimable;
 *  - old database files gain the columns via migrateMergeQueueTable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  SqliteMergeQueueEntryStore,
  migrateMergeQueueTable,
} from '../src/index';
import type { MergeQueueEntry } from '@ai-factory/git';

function tmpDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-mq-claim-'));
  return { dir, file: join(dir, 'factory.db') };
}

function makeEntry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: `entry-${Math.random().toString(16).slice(2)}`,
    repo: '/repo/a',
    prId: `pr-${Math.random().toString(16).slice(2)}`,
    taskId: 'task-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    status: 'QUEUED',
    position: 1,
    enqueuedBy: 'human',
    enqueuedAt: '2026-10-13T00:00:00.000Z',
    processedAt: null,
    baseSha: null,
    candidateSha: null,
    candidateTreeOid: null,
    targetSha: null,
    diffHash: null,
    artifactDigest: null,
    verification: null,
    failureReason: null,
    mergeCommitSha: null,
    decisionAuditRef: null,
    claimedBy: null,
    claimedAt: null,
    ...over,
  };
}

describe('SqliteMergeQueueEntryStore.tryClaim', () => {
  it('exactly one of two racing claimants wins', () => {
    const { dir, file } = tmpDb();
    try {
      const db = new FactoryDatabase(file);
      const storeA = new SqliteMergeQueueEntryStore(db.db);
      const db2 = new DatabaseSync(file);
      const storeB = new SqliteMergeQueueEntryStore(db2);
      try {
        const entry = makeEntry({ id: 'e-claim-1' });
        storeA.save(entry);
        // Two separate connections on the same file: the atomic UPDATE
        // means exactly one sees changes === 1.
        const aWins = storeA.tryClaim('e-claim-1', 'token-a', 300_000);
        const bWins = storeB.tryClaim('e-claim-1', 'token-b', 300_000);
        assert.equal(aWins, true);
        assert.equal(bWins, false);
        const row = storeA.get('e-claim-1');
        assert.equal(row?.claimedBy, 'token-a');
        assert.ok(row?.claimedAt);
      } finally {
        db2.close();
        (db.db).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the owner may re-claim; a fresh foreign claim is not stealable', () => {
    const { dir, file } = tmpDb();
    try {
      const db = new FactoryDatabase(file);
      const store = new SqliteMergeQueueEntryStore(db.db);
      try {
        store.save(makeEntry({ id: 'e-claim-2' }));
        assert.equal(store.tryClaim('e-claim-2', 'token-a', 300_000), true);
        // Own token: idempotent re-claim.
        assert.equal(store.tryClaim('e-claim-2', 'token-a', 300_000), true);
        // Fresh foreign claim: refused.
        assert.equal(store.tryClaim('e-claim-2', 'token-b', 300_000), false);
        assert.equal(store.get('e-claim-2')?.claimedBy, 'token-a');
      } finally {
        (db.db).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an expired claim is stealable (crashed holder)', () => {
    const { dir, file } = tmpDb();
    try {
      const db = new FactoryDatabase(file);
      const store = new SqliteMergeQueueEntryStore(db.db);
      try {
        const stale = new Date(Date.now() - 10 * 60_000).toISOString();
        store.save(makeEntry({ id: 'e-claim-3', claimedBy: 'dead-token', claimedAt: stale }));
        assert.equal(store.tryClaim('e-claim-3', 'token-b', 300_000), true);
        assert.equal(store.get('e-claim-3')?.claimedBy, 'token-b');
      } finally {
        (db.db).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminal rows are never claimable', () => {
    const { dir, file } = tmpDb();
    try {
      const db = new FactoryDatabase(file);
      const store = new SqliteMergeQueueEntryStore(db.db);
      try {
        store.save(makeEntry({ id: 'e-claim-4', status: 'MERGED' }));
        store.save(makeEntry({ id: 'e-claim-5', prId: 'other-pr', status: 'FAILED', position: 2 }));
        assert.equal(store.tryClaim('e-claim-4', 'token-a', 300_000), false);
        assert.equal(store.tryClaim('e-claim-5', 'token-a', 300_000), false);
        assert.equal(store.tryClaim('no-such-id', 'token-a', 300_000), false);
      } finally {
        (db.db).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrateMergeQueueTable adds the claim columns to old databases', () => {
    const { dir, file } = tmpDb();
    try {
      // Simulate a pre-Batch-23 database: the old table shape.
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE merge_queue_entries (
           id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, pr_id TEXT NOT NULL,
           task_id TEXT, source_branch TEXT NOT NULL, target_branch TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'QUEUED', position INTEGER NOT NULL,
           enqueued_by TEXT NOT NULL DEFAULT '', enqueued_at TEXT NOT NULL,
           processed_at TEXT, base_sha TEXT, candidate_sha TEXT,
           candidate_tree_oid TEXT, target_sha TEXT, diff_hash TEXT,
           artifact_digest TEXT, verification TEXT, failure_reason TEXT,
           merge_commit_sha TEXT, decision_audit_ref TEXT
        )`,
      );
      raw.close();
      // Opening via FactoryDatabase runs the migration.
      const db = new FactoryDatabase(file);
      try {
        const cols = new Set(
          (
            (db.db)
              .prepare('PRAGMA table_info(merge_queue_entries)')
              .all() as { name: string }[]
          ).map((c) => c.name),
        );
        assert.ok(cols.has('claimed_by'), 'claimed_by migrated in');
        assert.ok(cols.has('claimed_at'), 'claimed_at migrated in');
        // And the migrated store can claim.
        const store = new SqliteMergeQueueEntryStore(db.db);
        store.save(makeEntry({ id: 'e-claim-6' }));
        assert.equal(store.tryClaim('e-claim-6', 'token-a', 300_000), true);
      } finally {
        (db.db).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
