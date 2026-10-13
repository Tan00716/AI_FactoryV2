/**
 * WorktreeAllocator — SPEC v2 §22.1 (G-37, Batch 19).
 *
 * Skipped (not failed) when the `git` binary is unavailable: every
 * assertion here runs a real `git worktree add/remove` against
 * throwaway repos.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitBroker, GitBrokerDeniedError, GIT_ACTIONS } from '@ai-factory/git';
import { MemoryWorktreeStore } from '@ai-factory/db';
import {
  WorktreeAllocator,
  WorktreeUnavailableError,
  WorktreeReleaseRefusedError,
  WorktreeError,
  pathWithin,
} from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-wt-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'one');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function openBroker(allowed: readonly string[] = [...GIT_ACTIONS]) {
  return new GitBroker(
    { allowedActions: allowed as never, taskRequiredActions: ['worktree'] },
    {},
  );
}

const events: Array<{ e: string; d: Record<string, unknown> }> = [];

function makeAllocator(root: string, broker = openBroker()) {
  return new WorktreeAllocator({
    broker,
    store: new MemoryWorktreeStore(),
    rootDir: root,
    audit: (e, d) => events.push({ e, d }),
    now: () => '2026-10-13T00:00:00.000Z',
  });
}

describe('pathWithin', () => {
  it('confines paths to the root', () => {
    assert.equal(pathWithin('/r', '/r/wt-1'), true);
    assert.equal(pathWithin('/r', '/r'), true);
    assert.equal(pathWithin('/r', '/r2/x'), false);
    assert.equal(pathWithin('/r', '/r/../evil'), false);
  });
});

describe('WorktreeAllocator (git)', { skip: !gitAvailable }, () => {
  let dir = '';
  let repo = '';
  let root = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-wt-'));
    repo = initRepo();
    root = join(dir, 'roots');
    events.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('allocates a real git worktree with a deterministic task branch', async () => {
    const a = makeAllocator(root);
    const { record, reused } = await a.allocate({
      repoPath: repo,
      taskId: 'task-1234abcd',
      title: 'Fix payment bug',
      actor: 'tester',
    });
    assert.equal(reused, false);
    assert.equal(record.kind, 'git-worktree');
    assert.equal(record.branch, 'task/task1234-fix-payment-bug');
    assert.ok(record.worktreePath.startsWith(resolve(root) + '/'));
    assert.ok(existsSync(join(record.worktreePath, 'f.txt')));
    assert.equal(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: record.worktreePath,
      })
        .toString()
        .trim(),
      'task/task1234-fix-payment-bug',
    );
    assert.ok(events.some((x) => x.e === 'WORKTREE_ALLOCATED'));
  });

  it('re-allocate for the same (repo, task) is idempotent (reused)', async () => {
    const a = makeAllocator(root);
    const first = await a.allocate({ repoPath: repo, taskId: 'task-x' });
    const second = await a.allocate({ repoPath: repo, taskId: 'task-x' });
    assert.equal(second.reused, true);
    assert.equal(second.record.id, first.record.id);
    // still exactly one worktree besides the main one
    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
    }).toString();
    assert.equal(listed.split('\n').filter((l) => l.startsWith('worktree ')).length, 2);
  });

  it('concurrent allocates converge on the winner', async () => {
    const a = makeAllocator(root);
    const [r1, r2] = await Promise.all([
      a.allocate({ repoPath: repo, taskId: 'task-race' }),
      a.allocate({ repoPath: repo, taskId: 'task-race' }),
    ]);
    assert.equal(r1.record.id, r2.record.id);
    assert.equal(a.list({ taskId: 'task-race', status: 'ACTIVE' }).length, 1);
  });

  it('release removes the worktree and archives the record', async () => {
    const a = makeAllocator(root);
    const { record } = await a.allocate({ repoPath: repo, taskId: 'task-rel' });
    const p = record.worktreePath;
    const released = await a.release(record.id, { actor: 'tester' });
    assert.equal(released.status, 'RELEASED');
    assert.ok(!existsSync(p));
    assert.ok(events.some((x) => x.e === 'WORKTREE_RELEASED'));
    // double release is a state error, not a silent no-op
    await assert.rejects(a.release(record.id), /status is RELEASED/);
  });

  it('release refuses when the recorded path is tampered (TOCTOU)', async () => {
    const store = new MemoryWorktreeStore();
    const a = new WorktreeAllocator({
      broker: openBroker(),
      store,
      rootDir: root,
      audit: (e, d) => events.push({ e, d }),
    });
    const evil = store.insert({
      repoPath: repo,
      branch: 'task/evil-x',
      worktreePath: '/tmp/not-under-root',
      kind: 'git-worktree',
      taskId: 'task-evil',
    });
    await assert.rejects(
      a.release(evil.id),
      (e: unknown) => e instanceof WorktreeReleaseRefusedError,
    );
    assert.equal(store.get(evil.id)?.status, 'ACTIVE');
    assert.ok(events.some((x) => x.e === 'WORKTREE_RELEASE_REFUSED'));
    // nothing outside the root was touched
    assert.ok(existsSync(repo));
  });

  it('broker denial is zero-side-effect', async () => {
    const store = new MemoryWorktreeStore();
    const a = new WorktreeAllocator({
      broker: openBroker([]), // fail-closed: nothing allowed
      store,
      rootDir: root,
    });
    await assert.rejects(
      a.allocate({ repoPath: repo, taskId: 'task-denied' }),
      (e: unknown) => e instanceof GitBrokerDeniedError,
    );
    assert.equal(store.list().length, 0);
    const branches = execFileSync('git', ['branch', '--list'], { cwd: repo }).toString();
    assert.ok(!branches.includes('task/'));
  });

  it('taskId is required even when the broker would allow it', async () => {
    const a = makeAllocator(root);
    await assert.rejects(
      a.allocate({ repoPath: repo, taskId: '' }),
      (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_NO_TASK',
    );
  });

  it('missing source directory fails before anything is created', async () => {
    const a = makeAllocator(root);
    await assert.rejects(
      a.allocate({ repoPath: join(dir, 'nope'), taskId: 't' }),
      (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_REPO_NOT_FOUND',
    );
  });

  it('non-git source becomes an honestly labeled dir-copy', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'factory-wt-plain-'));
    writeFileSync(join(plain, 'app.txt'), 'hello');
    try {
      const a = makeAllocator(root);
      const { record } = await a.allocate({ repoPath: plain, taskId: 'task-plain' });
      assert.equal(record.kind, 'dir-copy');
      assert.equal(record.branch, null);
      assert.ok(existsSync(join(record.worktreePath, 'app.txt')));
      const released = await a.release(record.id);
      assert.equal(released.status, 'RELEASED');
      assert.ok(!existsSync(record.worktreePath));
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('git binary missing + git repo → fail-closed (no silent downgrade)', async () => {
    const store = new MemoryWorktreeStore();
    const a = new WorktreeAllocator({
      broker: openBroker(),
      store,
      rootDir: root,
      gitProbe: async () => false,
    });
    await assert.rejects(
      a.allocate({ repoPath: repo, taskId: 'task-nogit' }),
      (e: unknown) => e instanceof WorktreeUnavailableError,
    );
    assert.equal(store.list().length, 0);
  });

  it('git binary missing + non-git source → dir-copy still works', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'factory-wt-plain2-'));
    try {
      const a = new WorktreeAllocator({
        broker: openBroker(),
        store: new MemoryWorktreeStore(),
        rootDir: root,
        gitProbe: async () => false,
      });
      const { record } = await a.allocate({ repoPath: plain, taskId: 'task-p2' });
      assert.equal(record.kind, 'dir-copy');
      await a.release(record.id);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('release of a stale worktree (deleted outside git, pruned) still archives', async () => {
    const a = makeAllocator(root);
    const { record } = await a.allocate({ repoPath: repo, taskId: 'task-stale' });
    rmSync(record.worktreePath, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'prune'], { cwd: repo });
    const released = await a.release(record.id);
    assert.equal(released.status, 'RELEASED');
    assert.match(released.releaseNote ?? '', /stale/);
  });
});

describe('broker action vocabulary', () => {
  it("'worktree' is a first-class broker action and task-required by default", async () => {
    assert.ok((GIT_ACTIONS as readonly string[]).includes('worktree'));
    const broker = new GitBroker(
      { allowedActions: [...GIT_ACTIONS], taskRequiredActions: ['worktree'] },
      {},
    );
    const denied = await broker.authorize('worktree', {
      actor: 't',
      repo: '/r',
    });
    assert.equal(denied.allowed, false);
    const allowed = await broker.authorize('worktree', {
      actor: 't',
      repo: '/r',
      taskId: 'task-1',
    });
    assert.equal(allowed.allowed, true);
  });
});
