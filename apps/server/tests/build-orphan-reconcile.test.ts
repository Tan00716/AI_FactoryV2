/**
 * Batch 27 — orphaned build workspace reconcile.
 *
 * A SIGKILL between `git worktree add --detach` and the runner's
 * finally-block cleanup leaves a detached worktree on disk, still
 * registered in the source repo. The startup reconcile must reap it.
 *
 * NOTE (dual-mode rule, Batch 21 closeout): build-runner.ts
 * value-imports './routes/exec' extensionless, so tests import the
 * compiled dist here.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FactoryDatabase } from '@ai-factory/db';
import {
  reconcileBuildWorkspaces,
  writeWorkspaceMarker,
  procStartMs,
  isPidAlive,
  BUILD_WORKSPACE_MARKER,
} from '../dist/build-runner.js';

const TOKEN = 'orphan-reconcile-27-test-token-0123456789';

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-orphan-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  return dir;
}

interface AuditHit {
  actor: string;
  action: string;
  kind: string;
  name: string;
  details: Record<string, unknown>;
}
function auditStub() {
  const hits: AuditHit[] = [];
  return {
    hits,
    sink: {
      record(
        actor: string,
        action: string,
        kind: string,
        name: string,
        details?: Record<string, unknown>,
      ) {
        hits.push({ actor, action, kind, name, details: details ?? {} });
      },
    },
  };
}

function makeFdb(): { fdb: FactoryDatabase; dbFile: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-fdb-'));
  const dbFile = join(dir, 'factory.db');
  return { fdb: new FactoryDatabase(dbFile), dbFile, dir };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
function track(d: string): string {
  tmpDirs.push(d);
  return d;
}

describe('reconcileBuildWorkspaces', () => {
  it('cleans a dead-pid orphan: dir removed, git registration pruned, audited', async () => {
    const repo = track(makeRepo());
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-work-')));
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    try {
      const buildId = randomUUID();
      const workDir = join(workRoot, `build-${buildId}`);
      // Simulate the real orphan state: a registered detached worktree.
      git(repo, ['worktree', 'add', '--detach', workDir, sha]);
      // Marker of a process that is definitely dead (reaped child).
      const dead = spawn(process.execPath, ['-e', '']);
      await once(dead, 'exit');
      const deadPid = dead.pid as number;
      assert.ok(!isPidAlive(deadPid, null), 'sanity: reaped child is dead');
      writeWorkspaceMarker(workDir, buildId, repo, sha, { audit: () => undefined });
      // Overwrite with the dead pid to simulate the previous boot.
      const marker = JSON.parse(
        readFileSync(join(workDir, BUILD_WORKSPACE_MARKER), 'utf8'),
      );
      marker.pid = deadPid;
      marker.pidStartMs = null;
      writeFileSync(join(workDir, BUILD_WORKSPACE_MARKER), JSON.stringify(marker));
      assert.ok(git(repo, ['worktree', 'list']).includes(`build-${buildId}`));

      const r = await reconcileBuildWorkspaces(workRoot, { fdb, audit: audit.sink });

      assert.deepEqual(r.cleaned, [workDir]);
      assert.equal(r.errors.length, 0);
      assert.ok(!existsSync(workDir), 'orphan dir removed');
      assert.ok(
        !git(repo, ['worktree', 'list']).includes(`build-${buildId}`),
        'git worktree registration pruned',
      );
      const cleaned = audit.hits.find((h) => h.action === 'BUILD_ORPHAN_CLEANED');
      assert.ok(cleaned, 'BUILD_ORPHAN_CLEANED audited');
      assert.equal(cleaned?.details['hadMarker'], true);
      assert.match(
        String(cleaned?.details['note'] ?? ''),
        /cleaned, never replayed/,
        'audit note says cleanup, not replay',
      );
    } finally {
      fdb.close();
    }
  });

  it('skips a workspace whose build process is still alive', async () => {
    const repo = track(makeRepo());
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-work-')));
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    let sleeper: ChildProcess | undefined;
    try {
      const buildId = randomUUID();
      const workDir = join(workRoot, `build-${buildId}`);
      git(repo, ['worktree', 'add', '--detach', workDir, sha]);
      sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      const marker = {
        marker: 'ai-factory-build-workspace',
        buildId,
        repo,
        revision: sha,
        pid: sleeper.pid as number,
        pidStartMs: procStartMs(sleeper.pid as number),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(join(workDir, BUILD_WORKSPACE_MARKER), JSON.stringify(marker));
      assert.ok(isPidAlive(marker.pid, marker.pidStartMs));

      const r = await reconcileBuildWorkspaces(workRoot, { fdb, audit: audit.sink });

      assert.deepEqual(r.cleaned, []);
      assert.deepEqual(r.skippedAlive, [workDir]);
      assert.ok(existsSync(workDir), 'live workspace untouched');
      assert.ok(git(repo, ['worktree', 'list']).includes(`build-${buildId}`));
      assert.ok(
        audit.hits.some((h) => h.action === 'BUILD_ORPHAN_SKIPPED'),
        'skip audited',
      );
    } finally {
      sleeper?.kill('SIGKILL');
      fdb.close();
    }
  });

  it('never touches directories that do not match build-<uuid>', async () => {
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-work-')));
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    try {
      const other = join(workRoot, 'someone-elses-dir');
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, 'data.txt'), 'keep me\n');
      const r = await reconcileBuildWorkspaces(workRoot, { fdb, audit: audit.sink });
      assert.equal(r.scanned, 0);
      assert.ok(existsSync(join(other, 'data.txt')), 'foreign dir untouched');
      assert.equal(audit.hits.length, 0, 'no audit for foreign dirs');
    } finally {
      fdb.close();
    }
  });

  it('missing work root is a no-op (never created)', async () => {
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    try {
      const missing = join(tmpdir(), `orphan-nope-${randomUUID()}`);
      const r = await reconcileBuildWorkspaces(missing, { fdb, audit: audit.sink });
      assert.deepEqual(r.cleaned, []);
      assert.ok(!existsSync(missing), 'reconcile must not create the work root');
    } finally {
      fdb.close();
    }
  });

  it('no marker and no build record: skipped as unattributable', async () => {
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-work-')));
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    try {
      const workDir = join(workRoot, `build-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true });
      const r = await reconcileBuildWorkspaces(workRoot, { fdb, audit: audit.sink });
      assert.deepEqual(r.cleaned, []);
      assert.deepEqual(r.skippedUnknown, [workDir]);
      assert.ok(existsSync(workDir), 'unattributable dir kept');
    } finally {
      fdb.close();
    }
  });

  it('no marker but a build record exists: cleaned (pre-marker window)', async () => {
    const repo = track(makeRepo());
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-work-')));
    const { fdb, dir: fdbDir } = makeFdb();
    track(fdbDir);
    const audit = auditStub();
    try {
      const rec = fdb.builds.record({
        revision: sha,
        repo,
        prId: 'pr-x',
        sourceBranch: 'feat',
        targetBranch: 'main',
        builtBy: 'test',
      });
      const workDir = join(workRoot, `build-${rec.id}`);
      git(repo, ['worktree', 'add', '--detach', workDir, sha]);
      const r = await reconcileBuildWorkspaces(workRoot, { fdb, audit: audit.sink });
      assert.deepEqual(r.cleaned, [workDir]);
      assert.ok(!existsSync(workDir));
      const cleaned = audit.hits.find((h) => h.action === 'BUILD_ORPHAN_CLEANED');
      assert.equal(cleaned?.details['hadMarker'], false);
      assert.equal(fdb.builds.get(rec.id)?.status, 'NOT_EXECUTED', 'record untouched');
    } finally {
      fdb.close();
    }
  });
});

// ---------------------------------------------------------------- e2e ----

const serverMain = new URL('../dist/index.js', import.meta.url).pathname;
const serverCwd = new URL('..', import.meta.url).pathname;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function bootServer(
  port: number,
  dbFile: string,
  secretsDir: string,
  workRoot: string,
): ChildProcess {
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbFile,
      FACTORY_API_TOKEN: TOKEN,
      FACTORY_SECRETS_DIR: secretsDir,
      FACTORY_BUILD_COMMAND: 'node -e setTimeout(()=>{},12000)',
      FACTORY_BUILD_TIMEOUT_MS: '60000',
      FACTORY_BUILD_WORK_ROOT: workRoot,
    },
    stdio: 'ignore',
  });
  return child;
}

describe('orphan reconcile e2e (SIGKILL mid-build → reboot cleans)', () => {
  it('reaps the orphaned worktree on the next boot, audited, never replayed', async () => {
    const root = track(mkdtempSync(join(tmpdir(), 'orphan-e2e-')));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'root'], { cwd: repo });
    execFileSync('git', ['checkout', '-qb', 'feat'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'f\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'feat'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });

    const dbFile = join(root, 'factory.db');
    const secretsDir = join(root, 'secrets');
    mkdirSync(secretsDir, { recursive: true });
    // NOTE: the work root must live OUTSIDE the DB directory — the
    // execution policy refuses any build whose cwd touches the
    // control-plane data dir (honest refusal, caught here before).
    const workRoot = track(mkdtempSync(join(tmpdir(), 'orphan-e2e-work-')));
    const port = 28000 + Math.floor(Math.random() * 1000);

    // Boot A, merge, wait for the worktree, then SIGKILL mid-build.
    const serverA = bootServer(port, dbFile, secretsDir, workRoot);
    try {
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal((await api(port, 'GET', '/api/health')).status, 200);
      const project = await api(port, 'POST', '/api/projects', { name: 'ORPHANE2E' });
      const task = await api(port, 'POST', '/api/tasks', {
        projectId: project.body.id,
        title: 't',
        goal: 'g',
      });
      const pr = await api(port, 'POST', '/api/git/pr', {
        repo,
        taskId: task.body.id,
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'm',
      });
      const m = await api(port, 'POST', `/api/git/pr/${pr.body.id}/merge`, {
        repo,
        actor: 'human',
      });
      assert.equal(m.status, 200);

      let workDir: string | null = null;
      for (let i = 0; i < 30 && !workDir; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (existsSync(workRoot)) {
          const hit = readdirSync(workRoot).find((e) => e.startsWith('build-'));
          if (hit) workDir = join(workRoot, hit);
        }
      }
      assert.ok(workDir, 'build workspace appeared before SIGKILL');
      const orphanDir = workDir as string;
      // Sanity: the build is genuinely in-flight (not policy-refused).
      {
        const fdbCheck = new FactoryDatabase(dbFile);
        try {
          const st = fdbCheck.builds.list()[0]?.status;
          assert.equal(st, 'NOT_EXECUTED', `build in-flight, got ${st}`);
        } finally {
          fdbCheck.close();
        }
      }

      serverA.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 16000)); // let the build child exit
      assert.ok(existsSync(orphanDir), 'sanity: orphan exists after SIGKILL + child exit');
      assert.ok(
        git(repo, ['worktree', 'list']).includes('build-'),
        'sanity: git still registers the orphan',
      );

      // Boot B on the SAME db + work root: the startup reconcile reaps it.
      const serverB = bootServer(port, dbFile, secretsDir, workRoot);
      try {
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal((await api(port, 'GET', '/api/health')).status, 200);
        for (let i = 0; i < 15 && existsSync(orphanDir); i++) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        assert.ok(!existsSync(orphanDir), 'reconcile removed the orphan on reboot');
        assert.ok(
          !git(repo, ['worktree', 'list']).includes('build-'),
          'git worktree registration pruned',
        );
        const fdb = new FactoryDatabase(dbFile);
        try {
          const rows = fdb.audit.list().filter((a) => a.action === 'BUILD_ORPHAN_CLEANED');
          assert.ok(rows.length >= 1, 'BUILD_ORPHAN_CLEANED in the audit log');
          assert.match(
            String(rows[0].details['note'] ?? ''),
            /cleaned, never replayed/,
          );
          const builds = fdb.builds.list();
          assert.ok(builds.length >= 1);
          assert.equal(
            builds[0].status,
            'NOT_EXECUTED',
            'orphaned build record honestly stays NOT_EXECUTED — no replay',
          );
        } finally {
          fdb.close();
        }
      } finally {
        serverB.kill('SIGKILL');
      }
    } finally {
      try {
        serverA.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
});
