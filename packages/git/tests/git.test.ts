/**
 * Tests for the @ai-factory/git engine (spec §34).
 * Git-integration tests use a throwaway repo in a temp dir; each is skipped
 * gracefully (not failed) when the `git` binary is unavailable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GitRepo,
  GitError,
  taskBranchName,
  ensureTaskBranch,
  defaultBranchProtection,
  isProtected,
  assertPushAllowed,
  ProtectedBranchError,
  codeChangeEvidencePayload,
  mergeEvidencePayload,
  PrStore,
} from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}
/** node:test skip option: git tests degrade to skipped, never red. */
const needsGit = { skip: !gitAvailable } as const;

describe('taskBranchName', () => {
  it('builds task/<shortid>-<slug> from a task id and title', () => {
    const name = taskBranchName('3f2a1b4c-9d0e-4f1a-8b2c-7d3e5f6a8b9c', 'Fix payment bug');
    assert.equal(name, 'task/3f2a1b4c-fix-payment-bug');
  });

  it('slugifies: lowercases, collapses non-alnum, trims dashes', () => {
    const name = taskBranchName('abc', '  Hello, World! v2.0  ');
    assert.equal(name, 'task/abc0-hello-world-v2-0');
  });

  it('caps the slug at 40 characters', () => {
    const name = taskBranchName('abc', 'a'.repeat(100));
    const slug = name.slice('task/abc0-'.length);
    assert.ok(slug.length <= 40, `slug too long: ${slug}`);
  });

  it('never returns an empty slug', () => {
    assert.equal(taskBranchName('abc', '!!!'), 'task/abc0-task');
  });
});

describe('branch protection', () => {
  it('protects main and master by default, not feature branches', () => {
    const p = defaultBranchProtection();
    assert.equal(isProtected('main', p), true);
    assert.equal(isProtected('master', p), true);
    assert.equal(isProtected('task/abc-fix', p), false);
  });

  it('assertPushAllowed throws ProtectedBranchError on protected branches', () => {
    const p = defaultBranchProtection();
    assert.throws(() => assertPushAllowed('main', p), ProtectedBranchError);
    assert.throws(() => assertPushAllowed('main', p), /protected branch "main"/);
    assert.doesNotThrow(() => assertPushAllowed('feature/x', p));
  });

  it('respects a custom protected list', () => {
    const p = { protectedBranches: ['prod'], requirePr: true };
    assert.equal(isProtected('prod', p), true);
    assert.equal(isProtected('main', p), false);
  });
});

describe('evidence payloads + PR store', () => {
  it('codeChangeEvidencePayload returns a code_change payload', () => {
    const r = codeChangeEvidencePayload({
      sha: 'deadbeef',
      message: 'feat: x',
      author: 'agent',
      date: '2026-10-08T00:00:00Z',
    });
    assert.equal(r.type, 'code_change');
    assert.equal(r.payload.sha, 'deadbeef');
  });

  it('mergeEvidencePayload returns a merge payload', () => {
    const store = new PrStore();
    const pr = store.create({
      taskId: 't1',
      sourceBranch: 'task/a-x',
      targetBranch: 'main',
      title: 'X',
      commits: ['c1'],
      createdBy: 'agent',
    });
    const r = mergeEvidencePayload({ ...pr, mergedAt: '2026-10-08T00:00:00Z' });
    assert.equal(r.type, 'merge');
    assert.equal(r.payload.sourceBranch, 'task/a-x');
    assert.equal(r.payload.targetBranch, 'main');
    assert.deepEqual(r.payload.commits, ['c1']);
  });

  it('PrStore supports create/get/list/updateStatus', () => {
    const store = new PrStore();
    const pr = store.create({
      taskId: 't1',
      sourceBranch: 'task/a-x',
      targetBranch: 'main',
      title: 'Add X',
      commits: ['sha1', 'sha2'],
      createdBy: 'agent-1',
    });
    assert.equal(pr.status, 'OPEN');
    assert.equal(pr.mergedAt, null);
    assert.equal(store.get(pr.id).title, 'Add X');
    assert.equal(store.list().length, 1);
    const merged = store.updateStatus(pr.id, 'MERGED');
    assert.equal(merged.status, 'MERGED');
    assert.ok(merged.mergedAt);
    assert.throws(() => store.get('nope'), /PR not found/);
  });
});

describe('GitRepo integration', () => {
  const setup = (): { dir: string; repo: GitRepo } => {
    const dir = mkdtempSync(join(tmpdir(), 'git-engine-test-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@factory.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test Agent'], { cwd: dir });
    // git needs at least one commit before branches/HEAD exist
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
    return { dir, repo: new GitRepo(dir) };
  };
  const clean = (dir: string): void => {
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['clean', '-fd'], { cwd: dir, stdio: 'ignore' });
  };

  it('status() reports untracked files on a fresh repo', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    const s = await repo.status();
    assert.equal(s.branch, 'main');
    assert.deepEqual(s.untracked, ['hello.txt']);
    assert.deepEqual(s.staged, []);
    assert.deepEqual(s.unstaged, []);
  });

  it('commit() + log() round-trip and the audit hook fires', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    execFileSync('git', ['add', 'hello.txt'], { cwd: dir });
    const seen: Array<[string, Record<string, unknown>]> = [];
    const sha = await repo.commit('feat: add hello', {
      audit: (action, details) => seen.push([action, details]),
    });
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(seen[0][0], 'GIT_COMMIT');
    assert.equal(seen[0][1].sha, sha);

    const log = await repo.log(5);
    assert.equal(log[0].sha, sha);
    assert.equal(log[0].message, 'feat: add hello');
    assert.equal(log[0].author, 'Test Agent');
    assert.ok(log[0].date);
  });

  it('status() distinguishes staged, unstaged and untracked', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');
    writeFileSync(join(dir, 'base.txt'), 'base\nchanged\n'); // unstaged
    writeFileSync(join(dir, 'new.txt'), 'new\n'); // → staged
    execFileSync('git', ['add', 'new.txt'], { cwd: dir });
    writeFileSync(join(dir, 'loose.txt'), 'loose\n'); // untracked
    const s = await repo.status();
    assert.deepEqual(s.staged, ['new.txt']);
    assert.deepEqual(s.unstaged, ['base.txt']);
    assert.deepEqual(s.untracked, ['loose.txt']);
    clean(dir);
  });

  it('branches()/createBranch()/checkout() manage branches', needsGit, async () => {
    const { repo } = setup();
    await repo.createBranch('feature/one');
    const b = await repo.branches();
    assert.equal(b.current, 'main');
    assert.ok(b.all.includes('main'));
    assert.ok(b.all.includes('feature/one'));
    await repo.checkout('feature/one');
    assert.equal((await repo.branches()).current, 'feature/one');
    await repo.checkout('main');
  });

  it('diff() returns the working-tree diff', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');
    writeFileSync(join(dir, 'hello.txt'), 'hello\nmore\n');
    const d = await repo.diff();
    assert.ok(d.includes('+more'), `diff should contain the new line, got: ${d.slice(0, 160)}`);
    clean(dir);
  });

  it('commit() rejects empty messages with GitError', needsGit, async () => {
    const { repo } = setup();
    await assert.rejects(repo.commit('   '), (e: unknown) => e instanceof GitError);
  });

  it('failing commands throw GitError (never swallowed)', needsGit, async () => {
    const { repo } = setup();
    await assert.rejects(
      repo.checkout('no-such-branch-xyz'),
      (e: unknown) => e instanceof GitError,
    );
  });

  it('stashPush()/stashList()/stashPop() round-trip', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');
    writeFileSync(join(dir, 'tracked.txt'), 'tracked\nwip\n'); // tracked modification → stashable
    await repo.stashPush('wip work');
    const list = await repo.stashList();
    assert.equal(list.length, 1);
    assert.ok(list[0].includes('wip work'));
    await repo.stashPop();
    assert.deepEqual(await repo.stashList(), []);
    const s = await repo.status();
    assert.deepEqual(s.unstaged, ['tracked.txt']);
    clean(dir);
  });

  it('tag() creates a tag', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'f.txt'), 'f\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');
    await repo.tag('v0.1.0-test');
    const tags = execFileSync('git', ['tag', '-l'], { cwd: dir }).toString();
    assert.ok(tags.includes('v0.1.0-test'));
  });

  it('merge() returns conflicts instead of throwing', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');

    await repo.createBranch('feature/conflict');
    await repo.checkout('feature/conflict');
    writeFileSync(join(dir, 'hello.txt'), 'hello\nfeature line\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('feat: feature change');
    await repo.checkout('main');
    writeFileSync(join(dir, 'hello.txt'), 'hello\nmain line\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('feat: main change');

    const r = await repo.merge('feature/conflict');
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, ['hello.txt']);
    execFileSync('git', ['merge', '--abort'], { cwd: dir });
    assert.deepEqual((await repo.status()).unstaged, []);
  });

  it('merge() reports ok on a clean merge', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');

    await repo.createBranch('feature/clean');
    await repo.checkout('feature/clean');
    writeFileSync(join(dir, 'clean.txt'), 'clean\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const sha = await repo.commit('feat: clean addition');
    await repo.checkout('main');

    const r = await repo.merge('feature/clean');
    assert.equal(r.ok, true);
    assert.deepEqual(r.conflicts, []);
    const log = await repo.log(1);
    assert.equal(log[0].sha, sha);
  });

  it('ensureTaskBranch() creates and checks out task/<id>-<slug>', needsGit, async () => {
    const { repo } = setup();
    const branch = await ensureTaskBranch(repo, '8a3f2b1c-task', 'Add invoice PDF export');
    assert.equal(branch, 'task/8a3f2b1c-add-invoice-pdf-export');
    assert.equal((await repo.branches()).current, branch);
    // idempotent: second call just checks out
    assert.equal(await ensureTaskBranch(repo, '8a3f2b1c-task', 'Add invoice PDF export'), branch);
    await repo.checkout('main');
  });

  it('audit hook fires on every mutating operation', needsGit, async () => {
    const { repo } = setup();
    const actions: string[] = [];
    const audit = (action: string): void => {
      actions.push(action);
    };
    await repo.createBranch('audit-branch', { audit });
    await repo.checkout('audit-branch', { audit });
    await repo.checkout('main', { audit });
    await repo.commit('chore: empty', { allowEmpty: true, audit });
    await repo.tag('audit-tag', { audit });
    assert.deepEqual(actions, [
      'GIT_BRANCH_CREATED',
      'GIT_CHECKOUT',
      'GIT_CHECKOUT',
      'GIT_COMMIT',
      'GIT_TAG_CREATED',
    ]);
  });

  it('rebase() replays the current branch onto another', needsGit, async () => {
    const { dir, repo } = setup();
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('chore: base');
    await repo.createBranch('feature/rebase');
    await repo.checkout('feature/rebase');
    writeFileSync(join(dir, 'rb.txt'), 'rb\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await repo.commit('feat: rb work');
    await repo.rebase('main');
    const log = await repo.log(2);
    assert.equal(log[0].message, 'feat: rb work');
    assert.equal(log[1].message, 'chore: base');
  });
});

describe('git availability', () => {
  it('reports whether the git binary was found', () => {
    assert.equal(typeof gitAvailable, 'boolean');
  });
});
