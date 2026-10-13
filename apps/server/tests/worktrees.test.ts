/**
 * Worktree routes — SPEC v2 §22.1 (G-37, Batch 19).
 *
 * 1. Pure classification: GETs are viewer, POSTs are operator (the
 *    default write classification in src/auth.ts).
 * 2. The real server (dist/index.js) with role tokens, over a temp
 *    git repo and a temp worktree root:
 *      - POST /api/worktrees allocates a real worktree for a real
 *        task (201), re-allocate is idempotent (200, reused);
 *      - unknown task → 404, archived project → 409 (Batch 14 guard);
 *      - viewer POST → 403, anonymous → 401;
 *      - GET one / list with filters;
 *      - POST /:id/release removes the directory and archives;
 *      - double release → 409, unknown id → 404;
 *      - broker denial path is covered at package level; the server
 *        wires the default policy (task-bound), asserted by the
 *        taskless refusal never being reachable here (taskId required).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const VIEWER = 'viewer-secret-aaa';
const OPERATOR = 'operator-secret-bbb';
const ADMIN = 'admin-secret-ccc';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

describe('requiredRoleFor /api/worktrees (§22.1 RBAC classification)', () => {
  it('reads are viewer, mutations are operator', () => {
    assert.equal(requiredRoleFor('GET', '/api/worktrees'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/worktrees/abc'), 'viewer');
    assert.equal(requiredRoleFor('POST', '/api/worktrees'), 'operator');
    assert.equal(requiredRoleFor('POST', '/api/worktrees/abc/release'), 'operator');
  });
});

// ------------------------------------------------------- real server (e2e) --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface Booted {
  child: ChildProcess;
  port: number;
  dir: string;
}

async function bootRealServer(extraEnv: Record<string, string>): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-worktrees-e2e-'));
  const port = 26_000 + Math.floor(Math.random() * 18_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    FACTORY_WORKTREE_ROOT: join(dir, 'wt-root'),
    ...extraEnv,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_API_TOKENS', 'FACTORY_SECRETS_BACKEND', 'FACTORY_SECRETS_DIR']) {
    if (!(k in extraEnv)) delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port, dir };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopRealServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000))),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
}

function initRepo(dir: string): string {
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(join(repo, 'f.txt'), 'one');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

describe('Worktree routes on the real server (§22.1)', { skip: !gitAvailable }, () => {
  it('allocate → list → release lifecycle with RBAC and guards', { timeout: 120_000 }, async () => {
    const { child, port, dir } = await bootRealServer({
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed };
    };
    try {
      // A real project and two real tasks to own worktrees.
      const proj = await call('POST', '/api/projects', OPERATOR, { name: 'wt-proj' });
      assert.equal(proj.status, 201, JSON.stringify(proj.body));
      const projectId = proj.body['id'] as string;
      assert.ok(projectId);
      const task = await call('POST', '/api/tasks', OPERATOR, {
        projectId,
        title: 'Build the thing',
      });
      assert.equal(task.status, 201, JSON.stringify(task.body));
      const taskId = task.body['id'] as string;
      assert.ok(taskId);
      const taskB = await call('POST', '/api/tasks', OPERATOR, {
        projectId,
        title: 'Second thing',
      });
      assert.equal(taskB.status, 201, JSON.stringify(taskB.body));
      const taskBId = taskB.body['id'] as string;

      const repo = initRepo(dir);

      // RBAC: viewer cannot allocate, anonymous cannot at all.
      const denied = await call('POST', '/api/worktrees', VIEWER, {
        repoPath: repo,
        taskId,
      });
      assert.equal(denied.status, 403);
      const anon = await call('POST', '/api/worktrees', undefined, {
        repoPath: repo,
        taskId,
      });
      assert.equal(anon.status, 401);

      // Unknown task → 404.
      const noTask = await call('POST', '/api/worktrees', OPERATOR, {
        repoPath: repo,
        taskId: 'no-such-task',
      });
      assert.equal(noTask.status, 404);

      // Allocate (operator).
      const alloc = await call('POST', '/api/worktrees', OPERATOR, {
        repoPath: repo,
        taskId,
        title: 'Build the thing',
      });
      assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
      const wt = alloc.body['worktree'] as Record<string, unknown>;
      assert.equal(wt['kind'], 'git-worktree');
      assert.match(wt['branch'] as string, /^task\/[a-z0-9]{4,8}-build-the-thing$/);
      assert.ok(existsSync(join(wt['worktreePath'] as string, 'f.txt')));

      // Idempotent re-allocate.
      const again = await call('POST', '/api/worktrees', OPERATOR, {
        repoPath: repo,
        taskId,
      });
      assert.equal(again.status, 200);
      assert.equal(again.body['reused'], true);
      assert.equal(
        (again.body['worktree'] as Record<string, unknown>)['id'],
        wt['id'],
      );

      // List + filters (viewer can read).
      const list = await call('GET', `/api/worktrees?taskId=${taskId}`, VIEWER);
      assert.equal(list.status, 200);
      assert.equal((list.body['worktrees'] as unknown[]).length, 1);
      const one = await call('GET', `/api/worktrees/${wt['id']}`, VIEWER);
      assert.equal(one.status, 200);

      // Release removes the directory and archives the record.
      const rel = await call('POST', `/api/worktrees/${wt['id']}/release`, OPERATOR, {
        note: 'e2e done',
      });
      assert.equal(rel.status, 200);
      assert.equal((rel.body['worktree'] as Record<string, unknown>)['status'], 'RELEASED');
      assert.ok(!existsSync(wt['worktreePath'] as string));

      // Double release → 409; unknown id → 404.
      const rel2 = await call('POST', `/api/worktrees/${wt['id']}/release`, OPERATOR);
      assert.equal(rel2.status, 409);
      const rel404 = await call('POST', '/api/worktrees/nope/release', OPERATOR);
      assert.equal(rel404.status, 404);

      // Archived project → 409 on allocate (Batch 14 guard).
      const arch = await call('POST', `/api/projects/${projectId}/archive`, ADMIN, {});
      assert.ok([200, 204].includes(arch.status), JSON.stringify(arch.body));
      const blocked = await call('POST', '/api/worktrees', OPERATOR, {
        repoPath: repo,
        taskId: taskBId,
      });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body['code'], 'PROJECT_ARCHIVED');
    } finally {
      await stopRealServer(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
