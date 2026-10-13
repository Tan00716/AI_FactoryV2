/**
 * GitRepo worktree methods — Batch 19 (§22.1).
 *
 * Skipped (not failed) when the `git` binary is unavailable, like the
 * rest of this package's git-integration tests.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepo } from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-git-wt-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'one');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('GitRepo worktrees', { skip: !gitAvailable }, () => {
  let dir = '';
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('isGitRepository true inside a repo, false outside', async () => {
    assert.equal(await new GitRepo(dir).isGitRepository(), true);
    assert.equal(await new GitRepo(tmpdir()).isGitRepository(), false);
  });

  it('worktreeAdd creates the branch and the working tree; list/remove round-trip', async () => {
    const repo = new GitRepo(dir);
    const wt = join(dir, '..', 'wt-one');
    await repo.worktreeAdd(wt, { branch: 'task/ab12cd34-x' });
    assert.ok(existsSync(join(wt, 'f.txt')));
    const listed = await repo.worktreeList();
    assert.ok(listed.some((p) => p === wt || p.endsWith('wt-one')));
    const { all } = await repo.branches();
    assert.ok(all.includes('task/ab12cd34-x'));
    await repo.worktreeRemove(wt, { force: true });
    assert.ok(!existsSync(wt));
    assert.ok(!(await repo.worktreeList()).some((p) => p.endsWith('wt-one')));
    rmSync(wt, { recursive: true, force: true });
  });

  it('worktreeAdd attaches to an existing (not checked out) branch instead of recreating it', async () => {
    // git forbids the SAME branch in two worktrees at once — the
    // attach path is for a branch left behind by a released
    // allocation, which is checked out nowhere.
    const { execFileSync: exec } = await import('node:child_process');
    exec('git', ['branch', 'feature/shared'], { cwd: dir });
    const repo = new GitRepo(dir);
    const wt = join(dir, '..', 'wt-shared');
    try {
      await repo.worktreeAdd(wt, { branch: 'feature/shared' });
      assert.ok(existsSync(join(wt, 'f.txt')));
      const head = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt })
        .toString()
        .trim();
      assert.equal(head, 'feature/shared');
    } finally {
      await repo.worktreeRemove(wt, { force: true }).catch(() => undefined);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('worktreeAdd on a repo with no commits fails honestly', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'factory-git-empty-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: empty, stdio: 'ignore' });
      await assert.rejects(
        new GitRepo(empty).worktreeAdd(join(empty, '..', 'wt-x'), {
          branch: 'task/0000-x',
        }),
        /failed/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
