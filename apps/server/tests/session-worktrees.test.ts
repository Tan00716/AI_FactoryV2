/**
 * Session worktree tests (task 3 — session isolation, NOT the Batch-19
 * task-scoped /api/worktrees API; that one lives in worktrees.test.ts).
 *
 * worktrees.ts is node-builtins only, so it imports straight from src
 * (dual-mode import rule). All git operations run against real TEMPORARY
 * git repositories under os.tmpdir() — never against the ai-factory
 * working tree (the task under test IS worktree plumbing; touching the
 * real repo's worktree list would be reckless).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/session-worktrees.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionWorktreeManager,
  WorktreeError,
  parseWorktreePorcelain,
  worktreeErrorStatus,
} from '../src/worktrees.ts';

let tmpRoot: string;
let repoDir: string;
let mgr: SessionWorktreeManager;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A fresh git repo with one commit. Returns its dir. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpRoot, 'repo-'));
  try {
    git(['init', '-b', 'main'], dir);
  } catch {
    git(['init'], dir);
    git(['checkout', '-b', 'main'], dir);
  }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'hello.txt'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

function makeManager(): SessionWorktreeManager {
  return new SessionWorktreeManager({
    rootDir: join(tmpRoot, 'wt-root'),
    storeFile: join(tmpRoot, 'store', 'session-worktrees.json'),
    // Tests build their temp repos under tmpRoot — jail the manager there.
    workspaceRoot: tmpRoot,
    now: () => '2026-10-19T00:00:00.000Z',
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'swt-test-'));
  repoDir = makeRepo();
  mgr = makeManager();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('create → list → remove full flow on a temp git repo', () => {
  const { record } = mgr.createWorktree(repoDir, 'sess-a');
  assert.ok(record.id);
  assert.equal(record.name, 'sess-a');
  assert.ok(existsSync(record.worktreePath), 'worktree path exists on disk');
  // It is a real git worktree, not a copy.
  const inside = git(['rev-parse', '--is-inside-work-tree'], record.worktreePath).trim();
  assert.equal(inside, 'true');
  const head = git(['rev-parse', 'HEAD'], repoDir).trim();
  const wtHead = git(['rev-parse', 'HEAD'], record.worktreePath).trim();
  assert.equal(wtHead, head, 'detached worktree points at the repo HEAD');

  const listed = mgr.listWorktrees();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
  assert.equal(listed[0].head, head);
  assert.equal(listed[0].branch, null, 'detached → no branch');
  assert.equal(listed[0].registered, true);

  const removed = mgr.removeWorktree(record.id);
  assert.equal(removed.id, record.id);
  assert.ok(!existsSync(record.worktreePath), 'worktree path gone');
  assert.equal(mgr.listWorktrees().length, 0);
  // Honest boundary: branches are never deleted.
  const branches = git(['branch', '--list'], repoDir).trim();
  assert.ok(branches.includes('main'), 'main branch untouched');
});

test('dirty main checkout does not block worktree creation', () => {
  writeFileSync(join(repoDir, 'hello.txt'), 'dirty uncommitted change\n', 'utf8');
  const { record } = mgr.createWorktree(repoDir, 'dirty-ok');
  const wtContent = readFileSync(join(record.worktreePath, 'hello.txt'), 'utf8');
  assert.equal(wtContent, 'hello\n', 'worktree gets the clean HEAD, not the dirt');
});

test('.worktreeinclude copies listed files, skips unsafe entries', () => {
  writeFileSync(join(repoDir, '.env'), 'SECRET=abc\n', 'utf8');
  mkdirSync(join(repoDir, 'config'));
  writeFileSync(join(repoDir, 'config', 'app.json'), '{}\n', 'utf8');
  writeFileSync(
    join(repoDir, '.worktreeinclude'),
    '# include file\n.env\nconfig\n../evil\n/abs/path\n\n',
    'utf8',
  );
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'include'], repoDir);

  const { record, includeCopied, includeSkipped } = mgr.createWorktree(repoDir, 'incl');
  assert.deepEqual(includeCopied.sort(), ['.env', 'config']);
  assert.deepEqual(includeSkipped.sort(), ['../evil', '/abs/path']);
  assert.equal(readFileSync(join(record.worktreePath, '.env'), 'utf8'), 'SECRET=abc\n');
  assert.equal(readFileSync(join(record.worktreePath, 'config', 'app.json'), 'utf8'), '{}\n');
});

test('non-git directory fails closed with WORKTREE_NOT_A_GIT_REPO', () => {
  const plain = mkdtempSync(join(tmpRoot, 'plain-'));
  assert.throws(
    () => mgr.createWorktree(plain, 'nope'),
    (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_NOT_A_GIT_REPO',
  );
  assert.equal(mgr.listWorktrees().length, 0, 'nothing persisted on failure');
});

test('bad names are rejected', () => {
  for (const bad of ['', 'has space', '../x', 'a'.repeat(65), '-lead']) {
    assert.throws(
      () => mgr.createWorktree(repoDir, bad),
      (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_BAD_NAME',
      `name ${JSON.stringify(bad)}`,
    );
  }
});

test('project path outside the workspace is refused', () => {
  // /etc is a real dir but outside process.cwd() → path escape.
  assert.throws(
    () => mgr.createWorktree('/etc', 'esc'),
    (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_PATH_ESCAPE',
  );
});

test('sibling-prefix paths do not slip the workspace jail', () => {
  // A path like <tmpRoot>2/x shares a string prefix with the jail root
  // but is NOT inside it — the old slice-based check let this through.
  const sibling = tmpRoot + '2-evil';
  mkdirSync(sibling, { recursive: true });
  try {
    assert.throws(
      () => mgr.createWorktree(sibling, 'esc2'),
      (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_PATH_ESCAPE',
    );
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('remove of unknown id → WORKTREE_NOT_FOUND', () => {
  assert.throws(
    () => mgr.removeWorktree('does-not-exist'),
    (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_NOT_FOUND',
  );
});

test('pruneStale drops records whose path vanished', () => {
  const { record } = mgr.createWorktree(repoDir, 'prune-me');
  // Simulate hand-deletion outside the manager.
  rmSync(record.worktreePath, { recursive: true, force: true });
  const pruned = mgr.pruneStale();
  assert.deepEqual(pruned, [record.id]);
  assert.equal(mgr.listWorktrees().length, 0);
});

test('corrupt store fails closed: serves empty, refuses writes', () => {
  const m2 = makeManager();
  m2.createWorktree(repoDir, 'before-corrupt');
  assert.equal(m2.listWorktrees().length, 1);
  // Corrupt the file on disk, then reload through a fresh manager.
  writeFileSync(join(tmpRoot, 'store', 'session-worktrees.json'), '{not json', 'utf8');
  const m3 = makeManager();
  assert.equal(m3.isCorrupt(), true);
  assert.deepEqual(m3.listWorktrees(), [], 'corrupt → serves empty');
  assert.throws(
    () => m3.createWorktree(repoDir, 'after-corrupt'),
    (e: unknown) => e instanceof WorktreeError && e.code === 'WORKTREE_STORE_CORRUPT',
  );
});

test('parseWorktreePorcelain handles main + detached blocks', () => {
  const sample = [
    'worktree /repo/main',
    'HEAD abc123def456',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-x',
    'HEAD 789xyz000111',
    'detached',
    '',
  ].join('\n');
  const m = parseWorktreePorcelain(sample);
  assert.equal(m.size, 2);
  assert.deepEqual(m.get('/repo/main'), { branch: 'main', head: 'abc123def456' });
  assert.deepEqual(m.get('/repo/wt-x'), { branch: null, head: '789xyz000111' });
});

test('worktreeErrorStatus maps codes to HTTP statuses', () => {
  const cases: Array<[string, number]> = [
    ['WORKTREE_NOT_FOUND', 404],
    ['WORKTREE_PATH_ESCAPE', 403],
    ['WORKTREE_STORE_CORRUPT', 503],
    ['WORKTREE_GIT_FAILED', 500],
    ['WORKTREE_BAD_NAME', 400],
    ['WORKTREE_NOT_A_GIT_REPO', 400],
  ];
  for (const [code, status] of cases) {
    assert.equal(worktreeErrorStatus(new WorktreeError(code, 'x')), status, code);
  }
  assert.equal(worktreeErrorStatus(new Error('boom')), 500);
});
