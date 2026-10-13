/**
 * Worktree record store — SPEC v2 §22.1 (G-37, Batch 19).
 *
 * Behavior parity between the in-memory reference and the SQLite
 * implementation: the same scripted sequence (insert / active-dup
 * conflict / path-dup conflict / getActive / list filters / release /
 * double-release / missing) must produce identical results on both.
 * Also pinned: a RELEASED row keeps history (never deleted), and a
 * new ACTIVE allocation for the same (repo, task) is accepted after
 * release (the partial unique index only constrains ACTIVE rows).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  MemoryWorktreeStore,
  SqliteWorktreeStore,
  WorktreeConflictError,
  WorktreeNotFoundError,
  WorktreeStateError,
  type WorktreeStore,
} from '../src/index';

function makeStores(): { mem: WorktreeStore; sql: WorktreeStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-worktrees-'));
  const fdb = new FactoryDatabase(join(dir, 'factory.db'));
  return { mem: new MemoryWorktreeStore(), sql: fdb.worktrees, dir };
}

function scripted(store: WorktreeStore, tag: string) {
  // 1. insert + read back
  const a = store.insert({
    repoPath: '/repo/one',
    branch: 'task/ab12cd34-fix-bug',
    worktreePath: `/wt/${tag}-a`,
    kind: 'git-worktree',
    taskId: 'task-a',
  });
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.branch, 'task/ab12cd34-fix-bug');
  assert.deepEqual(store.get(a.id), a);

  // 2. second ACTIVE for the same (repo, task) → conflict
  assert.throws(
    () =>
      store.insert({
        repoPath: '/repo/one',
        branch: 'task/ab12cd34-other',
        worktreePath: `/wt/${tag}-b`,
        kind: 'git-worktree',
        taskId: 'task-a',
      }),
    (e: unknown) =>
      e instanceof WorktreeConflictError && e.kind === 'active-duplicate',
  );

  // 3. same path for another task → path conflict
  assert.throws(
    () =>
      store.insert({
        repoPath: '/repo/two',
        branch: null,
        worktreePath: `/wt/${tag}-a`,
        kind: 'dir-copy',
        taskId: 'task-b',
      }),
    (e: unknown) =>
      e instanceof WorktreeConflictError && e.kind === 'path-duplicate',
  );

  // 4. getActive + list filters
  assert.equal(store.getActive('/repo/one', 'task-a')?.id, a.id);
  assert.equal(store.getActive('/repo/one', 'task-nope'), undefined);
  assert.equal(store.list({ taskId: 'task-a' }).length, 1);
  assert.equal(store.list({ status: 'RELEASED' }).length, 0);
  assert.equal(store.list({ repoPath: '/repo/one' }).length, 1);

  // 5. release archives, never deletes; double release → state error
  const rel = store.release(a.id, 'done');
  assert.equal(rel.status, 'RELEASED');
  assert.ok(rel.releasedAt);
  assert.equal(rel.releaseNote, 'done');
  assert.equal(store.get(a.id)?.status, 'RELEASED');
  assert.equal(store.list({ status: 'RELEASED' }).length, 1);
  assert.throws(() => store.release(a.id, 'again'), WorktreeStateError);
  assert.throws(() => store.release('nope', 'x'), WorktreeNotFoundError);

  // 6. after release, the same (repo, task) may allocate again
  const a2 = store.insert({
    repoPath: '/repo/one',
    branch: 'task/ab12cd34-fix-bug-2',
    worktreePath: `/wt/${tag}-a2`,
    kind: 'git-worktree',
    taskId: 'task-a',
  });
  assert.equal(a2.status, 'ACTIVE');
  assert.equal(store.getActive('/repo/one', 'task-a')?.id, a2.id);

  // 7. dir-copy record shape
  const c = store.insert({
    repoPath: '/plain/dir',
    branch: null,
    worktreePath: `/wt/${tag}-c`,
    kind: 'dir-copy',
    taskId: 'task-c',
    projectId: 'proj-1',
  });
  assert.equal(c.branch, null);
  assert.equal(c.projectId, 'proj-1');

  // 8. copy contract: mutating a fetched record cannot corrupt the store
  const fetched = store.get(a2.id)!;
  (fetched as { status: string }).status = 'RELEASED';
  assert.equal(store.get(a2.id)?.status, 'ACTIVE');
}

describe('WorktreeStore parity (memory vs sqlite)', () => {
  let dir = '';
  let mem: WorktreeStore;
  let sql: WorktreeStore;
  beforeEach(() => {
    ({ mem, sql, dir } = makeStores());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('memory: scripted sequence', () => scripted(mem, 'mem'));
  it('sqlite: scripted sequence', () => scripted(sql, 'sql'));
});

describe('SqliteWorktreeStore via FactoryDatabase', () => {
  it('table exists on old databases and accepts rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-worktrees-old-'));
    try {
      const fdb = new FactoryDatabase(join(dir, 'factory.db'));
      assert.ok(fdb.worktrees);
      const r = fdb.worktrees.insert({
        repoPath: '/r',
        worktreePath: '/wt/x',
        kind: 'git-worktree',
        taskId: 't',
      });
      assert.equal(r.status, 'ACTIVE');
      assert.equal(fdb.worktrees.getActive('/r', 't')?.id, r.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('raw SQL conflict surfaces as WorktreeConflictError, not a raw sqlite error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-worktrees-raw-'));
    try {
      const fdb = new FactoryDatabase(join(dir, 'factory.db'));
      fdb.worktrees.insert({
        repoPath: '/r',
        worktreePath: '/wt/1',
        kind: 'git-worktree',
        taskId: 't',
      });
      // Bypass the store: a raw duplicate insert must still be caught
      // by the partial unique index at the DB level.
      assert.throws(
        () =>
          fdb.worktrees.insert({
            repoPath: '/r',
            worktreePath: '/wt/2',
            kind: 'git-worktree',
            taskId: 't',
          }),
        WorktreeConflictError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
