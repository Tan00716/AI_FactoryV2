/**
 * Merge Queue + PR persistence — SPEC v2 §36 (Batch 20).
 *
 * SqlitePrStore:
 *  - create/get/list round-trip the PR's core fields; get and
 *    updateStatus throw `PR not found: <id>` for unknown ids (same as
 *    the in-memory PrStore);
 *  - updateStatus('MERGED') stamps mergedAt; other statuses don't.
 * SqliteMergeQueueEntryStore:
 *  - save/load round-trip an entry field-for-field, including the five
 *    §36 evidence fields, the verification snapshot (JSON), the
 *    failure reason and the decision audit reference;
 *  - reads are copies (mutating a fetched entry cannot corrupt the row);
 *  - the partial unique index rejects a second ACTIVE (QUEUED or
 *    VERIFYING) row for the same PR — the cross-process double-enqueue
 *    guard — while a new entry after the old one went MERGED (or
 *    FAILED) is fine;
 *  - load() is scoped to one repo, in position order;
 *  - rows written by one FactoryDatabase are visible under the next
 *    (restart loses nothing), on an old database file that predates
 *    both tables entirely (CREATE TABLE IF NOT EXISTS covers it).
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
  SqlitePrStore,
} from '../src/index';
import type { MergeQueueEntry } from '@ai-factory/git';

function tmpDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-merge-queue-'));
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
    ...over,
  };
}

describe('SqlitePrStore', () => {
  it('create/get/list round-trip the PR core fields', () => {
    const { dir, file } = tmpDb();
    try {
      const fdb = new FactoryDatabase(file);
      const store: SqlitePrStore = fdb.prStore;
      assert.deepEqual(store.list(), []);
      const pr = store.create({
        taskId: 'task-1',
        sourceBranch: 'feat-x',
        targetBranch: 'main',
        title: 'Add x',
        createdBy: 'human',
        commits: ['abc123'],
      });
      assert.equal(pr.status, 'OPEN');
      assert.equal(pr.mergedAt, null);
      const got = store.get(pr.id);
      assert.deepEqual(got, pr);
      assert.equal(store.list().length, 1);
      // Mutating the fetched copy cannot corrupt the row.
      got.title = 'rewritten';
      assert.equal(store.get(pr.id).title, 'Add x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('get/updateStatus throw PR not found for unknown ids', () => {
    const { dir, file } = tmpDb();
    try {
      const store = new FactoryDatabase(file).prStore;
      assert.throws(() => store.get('nope'), /PR not found: nope/);
      assert.throws(() => store.updateStatus('nope', 'MERGED'), /PR not found: nope/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updateStatus('MERGED') stamps mergedAt; other statuses do not", () => {
    const { dir, file } = tmpDb();
    try {
      const store = new FactoryDatabase(file).prStore;
      const pr = store.create({
        taskId: 't', sourceBranch: 'f', targetBranch: 'main',
        title: 'x', createdBy: 'human',
      });
      const merged = store.updateStatus(pr.id, 'MERGED');
      assert.equal(merged.status, 'MERGED');
      assert.ok(merged.mergedAt);
      const closed = store.updateStatus(pr.id, 'CLOSED');
      assert.equal(closed.status, 'CLOSED');
      assert.equal(closed.mergedAt, merged.mergedAt, 'mergedAt is not rewritten');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteMergeQueueEntryStore', () => {
  it('save/load round-trips an entry field-for-field', () => {
    const { dir, file } = tmpDb();
    try {
      const store = new FactoryDatabase(file).mergeQueueEntries;
      const entry = makeEntry({
        status: 'MERGED',
        position: 3,
        processedAt: '2026-10-13T01:00:00.000Z',
        baseSha: 'b'.repeat(40),
        candidateSha: 'c'.repeat(40),
        candidateTreeOid: 't'.repeat(40),
        targetSha: 'm'.repeat(40),
        diffHash: 'd'.repeat(64),
        artifactDigest: null, // merges produce no artifact — stays null, never invented
        verification: {
          checks: [{ name: 'conflict', status: 'PASS', detail: 'clean' }],
          conflicts: [],
          verifiedAt: '2026-10-13T00:59:00.000Z',
        },
        mergeCommitSha: 'm'.repeat(40),
        decisionAuditRef: 'audit-123',
      });
      store.save(entry);
      // Mutating the input after save cannot corrupt the row.
      entry.taskId = 'rewritten';
      const got = store.load('/repo/a');
      assert.equal(got.length, 1);
      assert.deepEqual(got[0], { ...entry, taskId: 'task-1' });
      // Fetched rows are copies too.
      got[0].failureReason = 'rewritten';
      assert.equal(store.get(entry.id)?.failureReason, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('partial unique index: one ACTIVE entry per PR; terminal rows free the PR', () => {
    const { dir, file } = tmpDb();
    try {
      const store: SqliteMergeQueueEntryStore = new FactoryDatabase(file).mergeQueueEntries;
      store.save(makeEntry({ id: 'e1', prId: 'pr-1', status: 'QUEUED', position: 1 }));
      // Same PR, still active → rejected (the cross-process guard).
      assert.throws(
        () => store.save(makeEntry({ id: 'e2', prId: 'pr-1', status: 'VERIFYING', position: 2 })),
        /UNIQUE constraint failed/i,
      );
      // A different PR is unaffected.
      store.save(makeEntry({ id: 'e3', prId: 'pr-2', status: 'QUEUED', position: 3 }));
      // Once e1 is terminal, the PR may be queued again.
      const done = makeEntry({ id: 'e1', prId: 'pr-1', status: 'FAILED', position: 1 });
      store.save(done);
      store.save(makeEntry({ id: 'e4', prId: 'pr-1', status: 'QUEUED', position: 4 }));
      assert.equal(store.load('/repo/a').length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load is scoped to one repo, in position order', () => {
    const { dir, file } = tmpDb();
    try {
      const store = new FactoryDatabase(file).mergeQueueEntries;
      store.save(makeEntry({ id: 'b2', repo: '/repo/b', prId: 'pb2', position: 2 }));
      store.save(makeEntry({ id: 'b1', repo: '/repo/b', prId: 'pb1', position: 1 }));
      store.save(makeEntry({ id: 'a1', repo: '/repo/a', prId: 'pa1', position: 1 }));
      assert.deepEqual(store.load('/repo/b').map((e) => e.id), ['b1', 'b2']);
      assert.deepEqual(store.load('/repo/a').map((e) => e.id), ['a1']);
      assert.deepEqual(store.load('/repo/zzz'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setDecisionAuditRef records the decision audit reference', () => {
    const { dir, file } = tmpDb();
    try {
      const store = new FactoryDatabase(file).mergeQueueEntries;
      const entry = makeEntry({ id: 'e1', prId: 'pr-1' });
      store.save(entry);
      assert.equal(store.get('e1')?.decisionAuditRef, null);
      store.setDecisionAuditRef('e1', 'audit-9');
      assert.equal(store.get('e1')?.decisionAuditRef, 'audit-9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a reopen on a database that predates the tables', () => {
    const { dir, file } = tmpDb();
    try {
      // An "old" database: created by hand with only the projects table,
      // so the merge-queue tables arrive via CREATE TABLE IF NOT EXISTS.
      {
        const raw = new DatabaseSync(file);
        raw.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
        raw.close();
      }
      const fdb1 = new FactoryDatabase(file);
      const pr = fdb1.prStore.create({
        taskId: 't', sourceBranch: 'f', targetBranch: 'main',
        title: 'x', createdBy: 'human',
      });
      fdb1.mergeQueueEntries.save(makeEntry({ id: 'e1', prId: pr.id, status: 'VERIFYING' }));
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      assert.equal(fdb2.prStore.get(pr.id).title, 'x');
      const rows = fdb2.mergeQueueEntries.load('/repo/a');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'VERIFYING');
      fdb2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
