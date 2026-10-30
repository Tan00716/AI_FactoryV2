import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLocalLink } from '../src/local';
import { PrLinkError } from '../src/types';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aif-prlink-local-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init #1'], { cwd: dir });
  execFileSync('git', ['checkout', '-b', 'feat/#42-login'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'close #42, see owner/repo#7'], { cwd: dir });
  return dir;
}

test('branch + log references parsed, detached HEAD handled', () => {
  const dir = makeRepo();
  try {
    const link = getLocalLink(dir, 10);
    assert.equal(link.branch, 'feat/#42-login');
    assert.equal(link.commits.length, 2);
    assert.deepEqual(
      link.references.map((r) => `${r.repo ?? ''}#${r.number}`),
      ['#42', 'owner/repo#7', '#1'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a repo fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aif-prlink-norepo-'));
  try {
    assert.throws(() => getLocalLink(dir), (e: unknown) => e instanceof PrLinkError && e.code === 'not-a-repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
