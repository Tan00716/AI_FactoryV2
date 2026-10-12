/**
 * Tests for the Merge Queue (spec §36): merge-candidate verification
 * for "every PR passes alone, but they fail merged together".
 *
 * Real throwaway git repositories. The classic fixture: featA and
 * featB both rewrite the same line of f.txt — each merges cleanly into
 * main ON ITS OWN, but once A has landed, B conflicts. featC touches
 * an unrelated file and never conflicts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitRepo, MergeQueue, PrStore } from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}
const needsGit = { skip: !gitAvailable } as const;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Fixture {
  dir: string;
  baseSha: string;
}

/** main: f.txt = "line1\nline2"; featA/featB rewrite line1; featC adds g.txt. */
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'merge-queue-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'f.txt'), 'line1\nline2\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  const baseSha = git(dir, ['rev-parse', 'main']).trim();

  git(dir, ['checkout', '-qb', 'featA']);
  writeFileSync(join(dir, 'f.txt'), 'line1-A\nline2\n');
  git(dir, ['commit', '-qam', 'A']);
  git(dir, ['checkout', '-q', 'main']);

  git(dir, ['checkout', '-qb', 'featB']);
  writeFileSync(join(dir, 'f.txt'), 'line1-B\nline2\n');
  git(dir, ['commit', '-qam', 'B']);
  git(dir, ['checkout', '-q', 'main']);

  git(dir, ['checkout', '-qb', 'featC']);
  writeFileSync(join(dir, 'g.txt'), 'unrelated\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'C']);
  git(dir, ['checkout', '-q', 'main']);
  return { dir, baseSha };
}

function makePrs() {
  const prs = new PrStore();
  const a = prs.create({
    taskId: 'task-a',
    sourceBranch: 'featA',
    targetBranch: 'main',
    title: 'A',
    createdBy: 'human',
  });
  const b = prs.create({
    taskId: 'task-b',
    sourceBranch: 'featB',
    targetBranch: 'main',
    title: 'B',
    createdBy: 'human',
  });
  const c = prs.create({
    taskId: 'task-c',
    sourceBranch: 'featC',
    targetBranch: 'main',
    title: 'C',
    createdBy: 'human',
  });
  return { prs, a, b, c };
}

describe('the problem the queue solves (direct merge, for contrast)', () => {
  it('direct merging discovers the A+B conflict only at merge time, mid-merge', needsGit, async () => {
    const { dir } = makeFixture();
    const repo = new GitRepo(dir);
    const first = await repo.merge('featA');
    assert.equal(first.ok, true);
    const second = await repo.merge('featB');
    assert.equal(second.ok, false);
    assert.deepEqual(second.conflicts, ['f.txt']);
    // …and the repository is left in the middle of a merge.
    assert.ok(existsSync(join(dir, '.git', 'MERGE_HEAD')), 'repo left mid-merge');
    git(dir, ['merge', '--abort']);
  });
});

describe('MergeQueue candidate verification', () => {
  it('merges A, fails B at the CANDIDATE stage against the updated target, still lands C', needsGit, async () => {
    const { dir, baseSha } = makeFixture();
    const { prs, a, b, c } = makePrs();
    const queue = new MergeQueue(dir, { prs });
    queue.enqueue(a, 'human');
    queue.enqueue(b, 'human');
    queue.enqueue(c, 'human');

    const processed = await queue.processAll();
    assert.deepEqual(
      processed.map((e) => e.prId),
      [a.id, b.id, c.id],
      'strict FIFO processing order',
    );
    assert.deepEqual(
      processed.map((e) => e.position),
      [1, 2, 3],
    );
    const [ea, eb, ec] = processed;

    // A landed, with the five §36 fields recorded from real git facts.
    assert.equal(ea.status, 'MERGED');
    assert.equal(ea.baseSha, baseSha);
    assert.equal(ea.candidateSha, git(dir, ['rev-parse', 'featA']).trim());
    assert.equal(ea.mergeCommitSha, ea.targetSha);
    assert.ok(
      git(dir, ['rev-list', 'main']).split('\n').includes(ea.mergeCommitSha ?? ''),
      'merge commit is on main',
    );
    assert.ok(ea.targetSha && ea.targetSha !== baseSha);
    assert.match(ea.diffHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(ea.artifactDigest, null);
    assert.ok(ea.candidateTreeOid);
    assert.equal(ea.verification?.checks.find((x) => x.name === 'conflict')?.status, 'PASS');
    assert.equal(
      ea.verification?.checks.find((x) => x.name === 'tests')?.status,
      'SKIPPED',
      'no verifier configured is recorded as SKIPPED, never as a pass',
    );

    // B was verified against the target AFTER A landed — and failed
    // there, at candidate stage, not at merge time.
    assert.equal(eb.status, 'FAILED');
    assert.equal(eb.baseSha, ea.mergeCommitSha, 'candidate assembled against the updated target tip');
    assert.deepEqual(eb.verification?.conflicts, ['f.txt']);
    assert.equal(eb.verification?.checks.find((x) => x.name === 'conflict')?.status, 'FAIL');
    assert.equal(eb.verification?.checks.find((x) => x.name === 'tests')?.status, 'SKIPPED');
    assert.match(eb.failureReason ?? '', /conflicts with current main/);
    assert.match(eb.diffHash ?? '', /^[0-9a-f]{64}$/, 'failed candidate still records its proposed diff hash');
    assert.equal(eb.targetSha, eb.baseSha, 'nothing landed for B');

    // C was NOT swallowed by B's failure.
    assert.equal(ec.status, 'MERGED');
    assert.equal(ec.baseSha, ea.mergeCommitSha);

    // Repository end state: clean, on main, no merge in progress.
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
    assert.ok(!existsSync(join(dir, '.git', 'MERGE_HEAD')));
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'line1-A\nline2\n');
    assert.equal(readFileSync(join(dir, 'g.txt'), 'utf8'), 'unrelated\n');

    // PR records: A and C merged; B stays OPEN for its author.
    assert.equal(prs.get(a.id).status, 'MERGED');
    assert.equal(prs.get(b.id).status, 'OPEN');
    assert.equal(prs.get(c.id).status, 'MERGED');
  });

  it('enqueue alone merges nothing; processNext takes one entry at a time', needsGit, async () => {
    const { dir, baseSha } = makeFixture();
    const { prs, a } = makePrs();
    const queue = new MergeQueue(dir, { prs });
    const entry = queue.enqueue(a, 'human');
    assert.equal(entry.status, 'QUEUED');
    assert.equal(git(dir, ['rev-parse', 'main']).trim(), baseSha, 'main untouched before processing');

    const done = await queue.processNext();
    assert.equal(done?.status, 'MERGED');
    assert.notEqual(git(dir, ['rev-parse', 'main']).trim(), baseSha);
    assert.equal(await queue.processNext(), null, 'empty queue processes to null');
  });

  it('an injected verifier can fail a clean candidate — nothing lands', needsGit, async () => {
    const { dir, baseSha } = makeFixture();
    const { prs, a } = makePrs();
    const seen: Array<{ baseSha: string; candidateSha: string }> = [];
    const queue = new MergeQueue(dir, {
      prs,
      verify: async ({ candidate }) => {
        seen.push(candidate);
        return { ok: false, detail: 'unit tests failed: 3 failing' };
      },
    });
    queue.enqueue(a, 'human');
    const [entry] = await queue.processAll();
    assert.equal(entry.status, 'FAILED');
    assert.match(entry.failureReason ?? '', /verification failed/);
    assert.equal(entry.verification?.checks.find((x) => x.name === 'conflict')?.status, 'PASS');
    const tests = entry.verification?.checks.find((x) => x.name === 'tests');
    assert.equal(tests?.status, 'FAIL');
    assert.equal(tests?.detail, 'unit tests failed: 3 failing');
    assert.equal(git(dir, ['rev-parse', 'main']).trim(), baseSha, 'main untouched');
    assert.equal(prs.get(a.id).status, 'OPEN');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].baseSha, baseSha);
  });

  it('a passing injected verifier is recorded as PASS and the merge lands', needsGit, async () => {
    const { dir } = makeFixture();
    const { prs, a } = makePrs();
    const queue = new MergeQueue(dir, {
      prs,
      verifierName: 'ci',
      verify: async () => ({ ok: true, detail: 'ci green on candidate tree' }),
    });
    queue.enqueue(a, 'human');
    const [entry] = await queue.processAll();
    assert.equal(entry.status, 'MERGED');
    const ci = entry.verification?.checks.find((x) => x.name === 'ci');
    assert.equal(ci?.status, 'PASS');
    assert.equal(ci?.detail, 'ci green on candidate tree');
  });

  it('rejects enqueueing a non-OPEN PR and double-enqueueing', needsGit, async () => {
    const { dir } = makeFixture();
    const { prs, a } = makePrs();
    const queue = new MergeQueue(dir, { prs });
    queue.enqueue(a, 'human');
    assert.throws(() => queue.enqueue(a, 'human'), /already in the merge queue/);
    prs.updateStatus(a.id, 'CLOSED');
    const other = new MergeQueue(dir, { prs });
    assert.throws(() => other.enqueue(prs.get(a.id), 'human'), /status is CLOSED/);
  });
});
