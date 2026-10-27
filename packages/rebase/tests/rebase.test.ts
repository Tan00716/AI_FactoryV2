/**
 * Rebase + stash tests against real throwaway repos (home tmp, not /tmp).
 * Never touches the ai-factory worktree itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  abortRebase,
  applyStash,
  continueRebase,
  dropStash,
  headSha,
  listStash,
  logRange,
  popStash,
  pushStash,
  rebaseInProgress,
  runGit,
  showStash,
  startRebase,
  type TodoLine,
} from '../src/index.js';

let repo = '';
const dirs: string[] = [];

function git(args: string[]): void {
  const r = runGit(repo, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

function newRepo(): string {
  repo = mkdtempSync(join(homedir(), 'r6s2-test-'));
  dirs.push(repo);
  git(['init', '-b', 'main', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  return repo;
}

function commitFile(name: string, content: string, msg: string): void {
  writeFileSync(join(repo, name), content);
  git(['add', '.']);
  git(['commit', '-qm', msg]);
}

function basePlusThree(): { base: string; commits: { hash: string; subject: string }[] } {
  newRepo();
  commitFile('base.txt', 'base\n', 'base commit');
  const base = headSha(repo);
  commitFile('a.txt', 'a\n', 'commit A');
  commitFile('b.txt', 'b\n', 'commit B');
  commitFile('c.txt', 'c\n', 'commit C');
  return { base, commits: logRange(repo, base) };
}

test('startRebase reorders independent commits', () => {
  const { base, commits } = basePlusThree();
  assert.equal(commits.length, 3);
  const todos: TodoLine[] = [
    { action: 'pick', hash: commits[2].hash, subject: commits[2].subject },
    { action: 'pick', hash: commits[0].hash, subject: commits[0].subject },
    { action: 'pick', hash: commits[1].hash, subject: commits[1].subject },
  ];
  const res = startRebase({ repo, base, todos });
  assert.equal(res.status, 'completed', res.stderr);
  const after = logRange(repo, base).map((c) => c.subject);
  assert.deepEqual(after, ['commit C', 'commit A', 'commit B']);
});

test('startRebase drops and squashes', () => {
  const { base, commits } = basePlusThree();
  const todos: TodoLine[] = [
    { action: 'pick', hash: commits[0].hash, subject: commits[0].subject },
    { action: 'squash', hash: commits[1].hash, subject: commits[1].subject },
    { action: 'drop', hash: commits[2].hash, subject: commits[2].subject },
  ];
  const res = startRebase({ repo, base, todos });
  assert.equal(res.status, 'completed', res.stderr);
  const after = logRange(repo, base);
  assert.equal(after.length, 1);
  const files = runGit(repo, ['show', '--name-only', '--format=', 'HEAD']).stdout;
  assert.match(files, /a\.txt/);
  assert.match(files, /b\.txt/);
  assert.doesNotMatch(files, /c\.txt/);
});

test('startRebase rewords with a new single-line message', () => {
  const { base, commits } = basePlusThree();
  const todos: TodoLine[] = commits.map((c, i) => ({
    action: i === 1 ? ('reword' as const) : ('pick' as const),
    hash: c.hash,
    subject: c.subject,
    message: i === 1 ? 'commit B renamed' : undefined,
  }));
  const res = startRebase({ repo, base, todos });
  assert.equal(res.status, 'completed', res.stderr);
  const after = logRange(repo, base).map((c) => c.subject);
  assert.deepEqual(after, ['commit A', 'commit B renamed', 'commit C']);
});

test('startRebase refuses dirty tree and out-of-range todos', () => {
  const { base, commits } = basePlusThree();
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  assert.throws(
    () => startRebase({ repo, base, todos: commits.map((c) => ({ action: 'pick' as const, hash: c.hash, subject: c.subject })) }),
    /dirty/,
  );
  git(['checkout', '--', '.']);
  assert.throws(
    () =>
      startRebase({
        repo,
        base,
        todos: [
          { action: 'pick', hash: commits[0].hash, subject: '' },
          { action: 'pick', hash: commits[1].hash, subject: '' },
          { action: 'pick', hash: 'f'.repeat(40), subject: '' },
        ],
      }),
    /not in range/,
  );
});

test('conflicting rebase reports conflict, abort restores HEAD', () => {
  newRepo();
  commitFile('f.txt', 'line1\nline2\n', 'base');
  const base = headSha(repo);
  commitFile('f.txt', 'line1\nBASE-SIDE\n', 'base side');
  const baseSide = headSha(repo);
  git(['checkout', '-qb', 'feature', base]);
  commitFile('f.txt', 'line1\nFEATURE-SIDE\n', 'feature side');
  // Rebase feature onto base side: same line changed both ways -> conflict.
  const todos: TodoLine[] = [{ action: 'pick', hash: headSha(repo), subject: 'feature side' }];
  const res = startRebase({ repo, base: baseSide, todos });
  assert.equal(res.status, 'conflict', res.stderr);
  assert.equal(rebaseInProgress(repo), true);
  assert.deepEqual(res.conflictedFiles, ['f.txt']);
  const aborted = abortRebase(repo);
  assert.equal(aborted.status, 'completed');
  assert.equal(rebaseInProgress(repo), false);
  assert.equal(headSha(repo), todos[0].hash);
});

test('conflict resolved via working tree then continue completes', () => {
  newRepo();
  commitFile('f.txt', 'line1\nline2\n', 'base');
  const base = headSha(repo);
  commitFile('f.txt', 'line1\nBASE-SIDE\n', 'base side');
  const baseSide = headSha(repo);
  git(['checkout', '-qb', 'feature', base]);
  commitFile('f.txt', 'line1\nFEATURE-SIDE\n', 'feature side');
  const todos: TodoLine[] = [{ action: 'pick', hash: headSha(repo), subject: 'feature side' }];
  const res = startRebase({ repo, base: baseSide, todos });
  assert.equal(res.status, 'conflict');
  writeFileSync(join(repo, 'f.txt'), 'line1\nRESOLVED\n');
  git(['add', '.']);
  const done = continueRebase(repo);
  assert.equal(done.status, 'completed', done.stderr);
  assert.equal(rebaseInProgress(repo), false);
  const after = logRange(repo, baseSide);
  assert.equal(after.length, 1);
});

test('stash push/list/show/apply/pop/drop full chain', () => {
  newRepo();
  commitFile('s.txt', 'v1\n', 'init');
  writeFileSync(join(repo, 's.txt'), 'v2\n');
  const created = pushStash(repo, 'my stash', false);
  assert.equal(created.position, 0);
  assert.match(created.message, /my stash/);
  const listed = listStash(repo);
  assert.equal(listed.length, 1);
  assert.match(showStash(repo, 'stash@{0}'), /v2/);
  const applied = applyStash(repo, 'stash@{0}');
  assert.equal(applied.outcome, 'applied', applied.stderr);
  assert.equal(listStash(repo).length, 1, 'apply keeps the entry');
  git(['checkout', '--', '.']);
  const popped = popStash(repo, 'stash@{0}');
  assert.equal(popped.outcome, 'applied', popped.stderr);
  assert.equal(listStash(repo).length, 0, 'pop removes the entry');
  writeFileSync(join(repo, 's.txt'), 'v3\n');
  pushStash(repo, 'second', false);
  dropStash(repo, 'stash@{0}');
  assert.equal(listStash(repo).length, 0);
});

test('stash apply conflict reports conflicted files and keeps entry', () => {
  newRepo();
  commitFile('s.txt', 'one\n', 'init');
  writeFileSync(join(repo, 's.txt'), 'stashed\n');
  pushStash(repo, 'conflictor', false);
  writeFileSync(join(repo, 's.txt'), 'committed-differently\n');
  git(['add', '.']);
  git(['commit', '-qm', 'diverged']);
  const res = applyStash(repo, 'stash@{0}');
  assert.equal(res.outcome, 'conflict');
  assert.deepEqual(res.conflictedFiles, ['s.txt']);
  assert.equal(listStash(repo).length, 1, 'conflicted apply keeps the entry');
  git(['reset', '--hard', '-q']);
});

// Cleanup: remove throwaway repos (best-effort, never fails the suite).
process.on('exit', () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
