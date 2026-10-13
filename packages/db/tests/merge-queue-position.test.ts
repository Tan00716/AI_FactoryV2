/**
 * Batch 26 — merge queue enqueue position: DB-side arbiter.
 *
 * The (repo_path, position) unique index is what lets two processes
 * detect a position collision (enqueue() retries with a fresh
 * position). This file pins:
 *  1. migrateMergeQueueTable repairs pre-existing duplicates
 *     deterministically (earliest-enqueued keeps the position, the
 *     rest are bumped past the max — no entry dropped) and then
 *     enforces uniqueness;
 *  2. maxPosition() answers null on an empty repo and the true max
 *     otherwise.
 *
 * Tests run compiled from dist/tests/ (see package.json "test").
 */
import { describe, it, afterEach } from 'node:test';
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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-mq-pos-'));
  dirs.push(dir);
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

/** An "old" DB: current columns but no repo_position unique index. */
function openOldDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE merge_queue_entries (
    id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, pr_id TEXT NOT NULL,
    task_id TEXT NOT NULL DEFAULT '', source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED',
    position INTEGER NOT NULL, enqueued_by TEXT NOT NULL DEFAULT '',
    enqueued_at TEXT NOT NULL, processed_at TEXT, base_sha TEXT,
    candidate_sha TEXT, candidate_tree_oid TEXT, target_sha TEXT,
    diff_hash TEXT, artifact_digest TEXT, verification TEXT,
    failure_reason TEXT, merge_commit_sha TEXT, decision_audit_ref TEXT,
    claimed_by TEXT, claimed_at TEXT
  )`);
  return db;
}

describe('merge queue position arbiter (Batch 26)', () => {
  it('migration repairs colliding positions deterministically, then enforces uniqueness', () => {
    const { file } = tmpDb();
    const raw = openOldDb(file);
    try {
      const store = new SqliteMergeQueueEntryStore(raw);
      // Two rows, same repo + position: the pre-Batch-26 race outcome.
      store.save(makeEntry({ id: 'e-early', prId: 'pr-early', position: 4, enqueuedAt: '2026-10-13T00:00:00.000Z' }));
      store.save(makeEntry({ id: 'e-late', prId: 'pr-late', position: 4, enqueuedAt: '2026-10-13T00:01:00.000Z' }));
      store.save(makeEntry({ id: 'e-other', prId: 'pr-other', position: 9, enqueuedAt: '2026-10-13T00:02:00.000Z' }));

      migrateMergeQueueTable(raw);

      const rows = raw
        .prepare('SELECT id, position FROM merge_queue_entries ORDER BY position')
        .all() as { id: string; position: number }[];
      const byId = new Map(rows.map((r) => [r.id, r.position]));
      // Earliest-enqueued keeps the collided position; the later one is
      // bumped past the max (9 -> 10). Nothing dropped.
      assert.equal(byId.get('e-early'), 4);
      assert.equal(byId.get('e-late'), 10);
      assert.equal(byId.get('e-other'), 9);
      assert.equal(new Set(rows.map((r) => r.position)).size, 3);

      // The unique index now exists and arbitrates.
      const idx = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'merge_queue_repo_position'",
        )
        .all();
      assert.equal(idx.length, 1);
      assert.throws(
        () => store.save(makeEntry({ id: 'e-clash', prId: 'pr-clash', position: 4 })),
        /UNIQUE constraint failed: .*\.repo_path, .*\.position/,
      );
    } finally {
      raw.close();
    }
  });

  it('FactoryDatabase open applies the repair + index on a dirty old DB', () => {
    const { file } = tmpDb();
    const raw = openOldDb(file);
    const store = new SqliteMergeQueueEntryStore(raw);
    store.save(makeEntry({ id: 'e-1', prId: 'pr-1', position: 2, enqueuedAt: '2026-10-13T00:00:00.000Z' }));
    store.save(makeEntry({ id: 'e-2', prId: 'pr-2', position: 2, enqueuedAt: '2026-10-13T00:01:00.000Z' }));
    raw.close();

    // Opening through the real path must not fail loudly on the dirty DB.
    const fdb = new FactoryDatabase(file);
    try {
      const rows = (
        fdb.mergeQueueEntries.load('/repo/a') as { id: string; position: number }[]
      ).map((r) => r.position);
      assert.equal(new Set(rows).size, rows.length);
    } finally {
      fdb.close();
    }
  });

  it('maxPosition answers null on empty, true max otherwise', () => {
    const { file } = tmpDb();
    const fdb = new FactoryDatabase(file);
    try {
      const store = fdb.mergeQueueEntries;
      assert.equal(store.maxPosition('/repo/a'), null);
      store.save(makeEntry({ id: 'e-1', prId: 'pr-1', position: 3 }));
      store.save(makeEntry({ id: 'e-2', prId: 'pr-2', position: 7 }));
      store.save(makeEntry({ id: 'e-3', prId: 'pr-3', repo: '/repo/b', position: 42 }));
      assert.equal(store.maxPosition('/repo/a'), 7);
      assert.equal(store.maxPosition('/repo/b'), 42);
      assert.equal(store.maxPosition('/repo/empty'), null);
    } finally {
      fdb.close();
    }
  });
});
