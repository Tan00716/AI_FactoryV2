/**
 * gitops tests against real throwaway repos (home tmp, not /tmp).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  isGitRepo,
  listConflicted,
  readStage,
  stageFile,
  assertRelPath,
  runGit,
  Merge3Error,
} from '../src/index.js';

let repoDir = '';

function git(args: string[]): void {
  const r = runGit(repoDir, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Build a repo with one UU-conflicted file. */
function buildConflictRepo(): string {
  const dir = mkdtempSync(join(homedir(), 'r5s3-gittest-'));
  repoDir = dir;
  git(['init', '-b', 'main', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'same\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-qb', 'feature']);
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  git(['commit', '-qam', 'theirs change']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n2\nthree\n');
  git(['commit', '-qam', 'ours change']);
  const r = runGit(dir, ['merge', 'feature']);
  assert.notEqual(r.status, 0, 'expected merge conflict');
  return dir;
}

before(() => {
  buildConflictRepo();
});

test('isGitRepo', () => {
  assert.equal(isGitRepo(repoDir), true);
  assert.equal(isGitRepo(tmpdir()), false);
});

test('listConflicted finds the UU file', () => {
  const files = listConflicted(repoDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.txt');
  assert.equal(files[0].status, 'UU');
});

test('readStage returns base/ours/theirs', () => {
  assert.equal(readStage(repoDir, 'a.txt', 1), 'one\ntwo\nthree\n');
  assert.equal(readStage(repoDir, 'a.txt', 2), 'one\n2\nthree\n');
  assert.equal(readStage(repoDir, 'a.txt', 3), 'one\nTWO\nthree\n');
});

test('readStage of missing stage returns null', () => {
  assert.equal(readStage(repoDir, 'nope.txt', 1), null);
});

test('stageFile clears the conflict', () => {
  writeFileSync(join(repoDir, 'a.txt'), 'one\n2\nthree\n');
  stageFile(repoDir, 'a.txt');
  assert.deepEqual(listConflicted(repoDir), []);
  assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf8'), 'one\n2\nthree\n');
});

test('assertRelPath rejects escapes', () => {
  assert.throws(() => assertRelPath('../x'), (e) => (e as Merge3Error).code === 'path-escape');
  assert.throws(() => assertRelPath('/abs'), (e) => (e as Merge3Error).code === 'path-escape');
  assert.doesNotThrow(() => assertRelPath('sub/dir/f.txt'));
});

test('runGit failure surfaces stderr', () => {
  const r = runGit(repoDir, ['no-such-command-xyz']);
  assert.notEqual(r.status, 0);
});
