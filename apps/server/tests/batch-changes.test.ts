/**
 * Batch Changes unit tests (declarative multi-repo batch changes).
 *
 * Imports ../src/batch-changes.ts directly: the module value-imports
 * node builtins only, so it resolves under node's type-stripping ESM
 * loader.
 *
 * Target repos are throwaway git repositories under a temp dir — never
 * any real project directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BatchError,
  BatchExecutor,
  BatchStore,
  applyEditStep,
  createRepoRegistry,
  parseBatchSpecYaml,
  parseYamlSubset,
} from '../src/batch-changes.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
}

function makeGitRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello world\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const auditLog: Array<{ event: string; details?: unknown }> = [];
const audit = {
  record(actor: string, event: string, entity: string, entityId: string, details?: Record<string, unknown>) {
    void actor; void entity; void entityId;
    auditLog.push({ event, details });
  },
};

function resetAudit(): void {
  auditLog.length = 0;
}

/* ---------------- YAML subset parser ---------------- */

test('yaml: full spec shape parses', () => {
  const doc = parseYamlSubset(`
name: "dep upgrade"  # trailing comment
branch: batch/dep-1
repos:
  - repo-a
  - repo-b
steps:
  - name: "edit version"
    edit:
      file: package.json
      search: '"x": "1"'
      replace: '"x": "2"'
  - name: run tests
    run: npm test
`) as Record<string, unknown>;
  assert.equal(doc['name'], 'dep upgrade');
  assert.equal(doc['branch'], 'batch/dep-1');
  assert.deepEqual(doc['repos'], ['repo-a', 'repo-b']);
  const steps = doc['steps'] as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  assert.deepEqual((steps[0]['edit'] as Record<string, string>)['file'], 'package.json');
  assert.equal(steps[1]['run'], 'npm test');
});

test('yaml: duplicate keys and unknown scalars with colons', () => {
  assert.throws(() => parseYamlSubset('a: 1\na: 2'), /duplicate key/);
  // A scalar containing a colon inside a list must NOT become a map.
  const doc = parseYamlSubset('repos:\n  - http://example.com/x') as Record<string, unknown>;
  assert.deepEqual(doc['repos'], ['http://example.com/x']);
});

test('yaml: tabs rejected', () => {
  assert.throws(() => parseYamlSubset('a:\n\t- x'), /tabs/);
});

/* ---------------- spec validation ---------------- */

const GOOD_SPEC = `
name: test batch
branch: batch/test-1
repos:
  - repo-a
steps:
  - name: bump
    edit:
      file: file.txt
      search: hello
      replace: hi
  - name: echo
    run: echo ok
`;

test('spec: valid spec parses with defaults', () => {
  const spec = parseBatchSpecYaml(GOOD_SPEC);
  assert.equal(spec.name, 'test batch');
  assert.equal(spec.branch, 'batch/test-1');
  assert.deepEqual(spec.repos, ['repo-a']);
  assert.equal(spec.onFailure, 'stop');
  assert.equal(spec.branchExists, 'fail');
  assert.equal(spec.push, 'skip');
  assert.equal(spec.pr, false);
  assert.equal(spec.steps.length, 2);
});

test('spec: unknown top-level key rejected', () => {
  assert.throws(() => parseBatchSpecYaml('name: x\nbranch: b\nrepos: [r]\nsteps:\n  - name: s\n    run: echo\nextra: 1'), /unknown spec key/);
});

test('spec: bad branch names rejected', () => {
  for (const bad of ['../evil', 'a..b', 'has space', 'a@{b}']) {
    assert.throws(
      () => parseBatchSpecYaml(`name: x\nbranch: "${bad}"\nrepos:\n  - r\nsteps:\n  - name: s\n    run: echo`),
      /safe git ref/,
      bad,
    );
  }
});

test('spec: empty steps / empty repos rejected', () => {
  assert.throws(() => parseBatchSpecYaml('name: x\nbranch: b\nrepos: []\nsteps:\n  - name: s\n    run: echo'), /non-empty/);
  assert.throws(() => parseBatchSpecYaml('name: x\nbranch: b\nrepos:\n  - r\nsteps: []'), /non-empty/);
});

test('spec: edit must be relative without ..; absolute rejected', () => {
  const abs = 'name: x\nbranch: b\nrepos:\n  - r\nsteps:\n  - name: e\n    edit:\n      file: /etc/passwd\n      search: a\n      replace: b\n';
  assert.throws(() => parseBatchSpecYaml(abs), /relative path/);
  const dotdot = abs.replace('/etc/passwd', '../x');
  assert.throws(() => parseBatchSpecYaml(dotdot), /relative path/);
});

test('spec: step needs exactly one of run/edit', () => {
  const both = 'name: x\nbranch: b\nrepos:\n  - r\nsteps:\n  - name: s\n    run: echo\n    edit:\n      file: f\n      search: a\n      replace: b\n';
  assert.throws(() => parseBatchSpecYaml(both), /exactly one/);
});

test('spec: push/pr/onFailure/branchExists enums validated', () => {
  assert.throws(() => parseBatchSpecYaml(GOOD_SPEC + 'push: always\n'), /push/);
  assert.throws(() => parseBatchSpecYaml(GOOD_SPEC + 'onFailure: maybe\n'), /onFailure/);
  const pr = parseBatchSpecYaml(GOOD_SPEC + 'pr: true\n');
  assert.equal(pr.pr, true);
  const cont = parseBatchSpecYaml(GOOD_SPEC + 'onFailure: continue\n');
  assert.equal(cont.onFailure, 'continue');
});

/* ---------------- edit steps ---------------- */

test('edit: replaces first occurrence by default', () => {
  const root = tmpRoot();
  const f = path.join(root, 'f.txt');
  fs.writeFileSync(f, 'a a a\n', 'utf8');
  const r = applyEditStep(root, { file: 'f.txt', search: 'a', replace: 'b' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b a a\n');
});

test('edit: occurrences all', () => {
  const root = tmpRoot();
  const f = path.join(root, 'f.txt');
  fs.writeFileSync(f, 'a a a\n', 'utf8');
  const r = applyEditStep(root, { file: 'f.txt', search: 'a', replace: 'b', occurrences: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.matches, 3);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b b b\n');
});

test('edit: no match fails by default, passes with mustMatch:false', () => {
  const root = tmpRoot();
  const f = path.join(root, 'f.txt');
  fs.writeFileSync(f, 'zzz\n', 'utf8');
  const fail = applyEditStep(root, { file: 'f.txt', search: 'nope', replace: 'x' });
  assert.equal(fail.ok, false);
  assert.match(fail.note ?? '', /no match/);
  const ok = applyEditStep(root, { file: 'f.txt', search: 'nope', replace: 'x', mustMatch: false });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'zzz\n'); // unchanged
});

test('edit: path escape refused', () => {
  const root = tmpRoot();
  const r = applyEditStep(root, { file: '../../etc/x', search: 'a', replace: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.note ?? '', /PATH_ESCAPE/);
});

test('edit: fewer matches than requested occurrences fails', () => {
  const root = tmpRoot();
  const f = path.join(root, 'f.txt');
  fs.writeFileSync(f, 'a b\n', 'utf8');
  const r = applyEditStep(root, { file: 'f.txt', search: 'a', replace: 'b', occurrences: 3 });
  assert.equal(r.ok, false);
  assert.match(r.note ?? '', /only 1 of 3/);
});

/* ---------------- registry ---------------- */

test('registry: empty FACTORY_REPO_ROOTS denies everything (fail-closed)', () => {
  withEnv({ FACTORY_REPO_ROOTS: undefined, XDG_CONFIG_HOME: tmpRoot() }, () => {
    const reg = createRepoRegistry();
    assert.throws(
      () => reg.register({ name: 'r', path: tmpRoot() }),
      /outside the allowed roots/,
    );
  });
});

test('registry: non-git directory refused', () => {
  const root = tmpRoot();
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  withEnv({ FACTORY_REPO_ROOTS: root, XDG_CONFIG_HOME: tmpRoot() }, () => {
    const reg = createRepoRegistry();
    assert.throws(() => reg.register({ name: 'r', path: plain }), /not a git repository/);
  });
});

test('registry: register / list / duplicate / unregister', () => {
  const root = tmpRoot();
  const repo = makeGitRepo(root, 'r1');
  withEnv({ FACTORY_REPO_ROOTS: root, XDG_CONFIG_HOME: tmpRoot() }, () => {
    const reg = createRepoRegistry();
    const rec = reg.register({ name: 'repo-a', path: repo, remoteUrl: 'https://example.com/x.git' });
    assert.equal(rec.name, 'repo-a');
    assert.equal(rec.scope, 'global');
    assert.equal(reg.list().length, 1);
    assert.throws(() => reg.register({ name: 'repo-a', path: repo }), /already registered/);
    assert.equal(reg.unregister('repo-a'), true);
    assert.equal(reg.list().length, 0);
    assert.equal(reg.unregister('repo-a'), false);
  });
});

test('registry: project scope wins over global', () => {
  const root = tmpRoot();
  const repoG = makeGitRepo(root, 'g');
  const repoP = makeGitRepo(root, 'p');
  const project = path.join(root, 'proj');
  fs.mkdirSync(project, { recursive: true });
  withEnv({ FACTORY_REPO_ROOTS: root, XDG_CONFIG_HOME: tmpRoot() }, () => {
    const reg = createRepoRegistry();
    reg.register({ name: 'same', path: repoG });
    reg.register({ name: 'same', path: repoP, projectPath: project });
    const got = reg.get('same', project);
    assert.equal(got?.path, repoP);
    const globalOnly = reg.get('same');
    assert.equal(globalOnly?.path, repoG);
  });
});

/* ---------------- executor ---------------- */

function makeExecutor(root: string, repoNames: string[]): { ex: BatchExecutor; store: BatchStore } {
  const repos = repoNames.map((n) => makeGitRepo(root, n));
  const xdg = tmpRoot();
  withEnv({ FACTORY_REPO_ROOTS: root, XDG_CONFIG_HOME: xdg }, () => {
    const reg = createRepoRegistry();
    repoNames.forEach((n, i) => reg.register({ name: n, path: repos[i] }));
  });
  process.env.FACTORY_REPO_ROOTS = root;
  process.env.XDG_CONFIG_HOME = xdg;
  const registry = createRepoRegistry();
  const store = new BatchStore(path.join(tmpRoot(), 'batch.json'));
  const ex = new BatchExecutor({ registry, store, audit, now: () => '2026-01-01T00:00:00.000Z' });
  return { ex, store };
}

test('executor: create + run edits files and creates branch on each repo', async () => {
  resetAudit();
  const root = tmpRoot();
  const { ex } = makeExecutor(root, ['repo-a', 'repo-b']);
  try {
    const batch = ex.createBatch(GOOD_SPEC, 'human');
    assert.equal(batch.status, 'created');
    assert.ok(auditLog.some((a) => a.event === 'BATCH_CREATED'));
    const done = await ex.runBatch(batch.id, 'human');
    assert.equal(done.status, 'done');
    for (const r of done.repos) {
      assert.equal(r.status, 'success', r.name);
      assert.equal(r.branch, 'batch/test-1');
      assert.equal(r.push, 'not-attempted');
      assert.equal(r.stepResults.length, 2);
      assert.ok(r.stepResults.every((s) => s.ok));
      assert.equal(fs.readFileSync(path.join(r.path, 'file.txt'), 'utf8'), 'hi world\n');
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: r.path, encoding: 'utf8' }).trim();
      assert.equal(branch, 'batch/test-1');
    }
    assert.ok(auditLog.some((a) => a.event === 'BATCH_REPO_DONE'));
  } finally {
    delete process.env.FACTORY_REPO_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('executor: run step failure fails repo (exit code judgment)', async () => {
  resetAudit();
  const root = tmpRoot();
  const { ex } = makeExecutor(root, ['repo-a']);
  const spec = 'name: x\nbranch: batch/f1\nrepos:\n  - repo-a\nsteps:\n  - name: boom\n    run: exit 3\n';
  try {
    const batch = ex.createBatch(spec, 'human');
    const done = await ex.runBatch(batch.id, 'human');
    const r = done.repos[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.stepResults[0].exitCode, 3);
    assert.match(r.error ?? '', /exit 3/);
    assert.ok(auditLog.some((a) => a.event === 'BATCH_STEP_FAILED'));
  } finally {
    delete process.env.FACTORY_REPO_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('executor: onFailure stop skips remaining repos; continue runs them', async () => {
  for (const mode of ['stop', 'continue'] as const) {
    resetAudit();
    const root = tmpRoot();
    const { ex } = makeExecutor(root, ['repo-a', 'repo-b']);
    const spec = `name: x\nbranch: batch/${mode}\nrepos:\n  - repo-a\n  - repo-b\nonFailure: ${mode}\nsteps:\n  - name: fail-on-a\n    run: '[ "$(basename $(pwd))" = "repo-b" ]'\n`;
    try {
      const batch = ex.createBatch(spec, 'human');
      const done = await ex.runBatch(batch.id, 'human');
      const statuses = done.repos.map((r) => r.status);
      if (mode === 'stop') assert.deepEqual(statuses, ['failed', 'skipped']);
      else assert.deepEqual(statuses, ['failed', 'success']);
    } finally {
      delete process.env.FACTORY_REPO_ROOTS;
      delete process.env.XDG_CONFIG_HOME;
    }
  }
});

test('executor: branchExists fail vs skip', async () => {
  for (const policy of ['fail', 'skip'] as const) {
    resetAudit();
    const root = tmpRoot();
    const { ex } = makeExecutor(root, ['repo-a']);
    const spec = `name: x\nbranch: batch/exist\nbranchExists: ${policy}\nrepos:\n  - repo-a\nsteps:\n  - name: s\n    run: echo ok\n`;
    try {
      const b1 = ex.createBatch(spec, 'human');
      await ex.runBatch(b1.id, 'human');
      // Run again: branch now exists.
      const b2 = ex.createBatch(spec, 'human');
      const done = await ex.runBatch(b2.id, 'human');
      if (policy === 'fail') assert.equal(done.repos[0].status, 'failed');
      else assert.equal(done.repos[0].status, 'skipped');
    } finally {
      delete process.env.FACTORY_REPO_ROOTS;
      delete process.env.XDG_CONFIG_HOME;
    }
  }
});

test('executor: createBatch refuses unknown repo', () => {
  const root = tmpRoot();
  const { ex } = makeExecutor(root, ['repo-a']);
  try {
    assert.throws(() => ex.createBatch(GOOD_SPEC.replace('repo-a', 'ghost'), 'human'), /not registered/);
  } finally {
    delete process.env.FACTORY_REPO_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('executor: push try without remote → skipped-no-remote (never silent)', async () => {
  resetAudit();
  const root = tmpRoot();
  const { ex } = makeExecutor(root, ['repo-a']);
  const spec = 'name: x\nbranch: batch/push1\npush: try\nrepos:\n  - repo-a\nsteps:\n  - name: s\n    run: echo ok\n';
  try {
    const batch = ex.createBatch(spec, 'human');
    const done = await ex.runBatch(batch.id, 'human');
    assert.equal(done.repos[0].push, 'skipped-no-remote');
    assert.ok(auditLog.some((a) => a.event === 'BATCH_PUSH_SKIPPED'));
  } finally {
    delete process.env.FACTORY_REPO_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('executor: retry resets a failed repo and reruns it', async () => {
  resetAudit();
  const root = tmpRoot();
  const { ex } = makeExecutor(root, ['repo-a']);
  const spec = 'name: x\nbranch: batch/retry1\nrepos:\n  - repo-a\nsteps:\n  - name: boom\n    run: exit 1\n';
  try {
    const batch = ex.createBatch(spec, 'human');
    const done = await ex.runBatch(batch.id, 'human');
    assert.equal(done.repos[0].status, 'failed');
    // Fix the spec by editing the stored batch steps (simulates operator fixing the command).
    const fixed = ex['store'].get(batch.id);
    assert.ok(fixed);
    fixed.spec.steps = [{ name: 'fixed', run: 'echo ok' }];
    ex['store'].save(fixed);
    const retried = await ex.retryRepo(batch.id, 'repo-a', 'human');
    assert.equal(retried.repos[0].status, 'success');
    assert.ok(auditLog.some((a) => a.event === 'BATCH_REPO_RETRY'));
  } finally {
    delete process.env.FACTORY_REPO_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('store: corrupt file fails closed', () => {
  const root = tmpRoot();
  const p = path.join(root, 'batch.json');
  fs.writeFileSync(p, '{not json', 'utf8');
  const store = new BatchStore(p);
  assert.equal(store.isCorrupt(), true);
  assert.throws(() => store.save({} as never), /corrupt/);
});

test('BatchError carries codes', () => {
  const e = new BatchError('SPEC_INVALID', 'x');
  assert.equal(e.code, 'SPEC_INVALID');
});
