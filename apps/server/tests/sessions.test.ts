/**
 * Session HTTP tests (W-D).
 *
 * Boots the real server (dist) with an isolated DB + data dir:
 *   POST /api/sessions → 201 · GET list/one · 404s · 400 on missing title
 *   POST /api/sessions/:id/archive → archived
 *   POST /api/sessions/:id/attach → task link validated (404 on unknown)
 *   POST /api/sessions/:id/resume → resume bundle (session+tasks+run points)
 *   POST /api/sessions/:id/checkpoints → 201 (git diff best-effort)
 *   codeRoot inside the server data dir → 403 SESSION_CODE_ROOT_DENIED
 *   POST .../checkpoints/:cid/restore → true code rollback in a git repo
 *   (+ auto pre-restore safety checkpoint)
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/sessions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  dataDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-sessions-'));
  const port = await freePort();
  const dataDir = path.join(dir, 'data');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: dataDir,
    AI_FACTORY_SESSION_STORE_FILE: path.join(dataDir, 'sessions.json'),
    AI_FACTORY_SESSION_CHECKPOINTS_FILE: path.join(dataDir, 'session-checkpoints.json'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir, dataDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeSession(port: number, title = 'e2e chat'): Promise<string> {
  const r = await api(port, 'POST', '/api/sessions', { title });
  assert.equal(r.status, 201);
  return r.body.session.id as string;
}

test('session CRUD: create/list/get + 404/400', async () => {
  const s = await startServer();
  try {
    const created = await api(s.port, 'POST', '/api/sessions', { title: 'chat one' });
    assert.equal(created.status, 201);
    const id = created.body.session.id as string;
    assert.equal(created.body.session.status, 'active');

    const list = await api(s.port, 'GET', '/api/sessions');
    assert.equal(list.status, 200);
    assert.ok((list.body.sessions as { id: string }[]).some((x) => x.id === id));

    const one = await api(s.port, 'GET', `/api/sessions/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.session.title, 'chat one');

    const missing = await api(s.port, 'GET', '/api/sessions/nope');
    assert.equal(missing.status, 404);

    const bad = await api(s.port, 'POST', '/api/sessions', { title: '  ' });
    assert.equal(bad.status, 400);
  } finally {
    await stopServer(s);
  }
});

test('archive flips status', async () => {
  const s = await startServer();
  try {
    const id = await makeSession(s.port);
    const r = await api(s.port, 'POST', `/api/sessions/${id}/archive`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.session.status, 'archived');
  } finally {
    await stopServer(s);
  }
});

test('attach validates task existence', async () => {
  const s = await startServer();
  try {
    const project = await api(s.port, 'POST', '/api/projects', { name: 'Sess P' });
    assert.equal(project.status, 201);
    const task = await api(s.port, 'POST', '/api/tasks', {
      projectId: project.body.id,
      title: 'linked task',
    });
    assert.equal(task.status, 201);
    const taskId = task.body.id as string;

    const id = await makeSession(s.port);
    const ok = await api(s.port, 'POST', `/api/sessions/${id}/attach`, { taskId });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.session.taskIds, [taskId]);

    const badTask = await api(s.port, 'POST', `/api/sessions/${id}/attach`, { taskId: 'nope' });
    assert.equal(badTask.status, 404);

    const badSession = await api(s.port, 'POST', '/api/sessions/nope/attach', { taskId });
    assert.equal(badSession.status, 404);

    const empty = await api(s.port, 'POST', `/api/sessions/${id}/attach`, {});
    assert.equal(empty.status, 400);
  } finally {
    await stopServer(s);
  }
});

test('resume returns the bundle', async () => {
  const s = await startServer();
  try {
    const project = await api(s.port, 'POST', '/api/projects', { name: 'Sess P2' });
    const task = await api(s.port, 'POST', '/api/tasks', {
      projectId: project.body.id,
      title: 'resume task',
    });
    const id = await makeSession(s.port, 'resume me');
    await api(s.port, 'POST', `/api/sessions/${id}/attach`, { taskId: task.body.id });
    const r = await api(s.port, 'POST', `/api/sessions/${id}/resume`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.session.id, id);
    assert.equal((r.body.tasks as unknown[]).length, 1);
    assert.equal((r.body.tasks as { title: string }[])[0].title, 'resume task');
    assert.deepEqual(r.body.runResumePoints, []);
    assert.ok(r.body.resumedAt);
  } finally {
    await stopServer(s);
  }
});

test('checkpoint create/list; data-dir codeRoot refused', async () => {
  const s = await startServer();
  try {
    const id = await makeSession(s.port);
    const cp = await api(s.port, 'POST', `/api/sessions/${id}/checkpoints`, { label: 'v1' });
    assert.equal(cp.status, 201);
    assert.equal(cp.body.checkpoint.label, 'v1');
    assert.equal(cp.body.checkpoint.gitDiff, null);
    assert.equal(cp.body.checkpoint.gitDiffNote, 'no-code-root');

    const list = await api(s.port, 'GET', `/api/sessions/${id}/checkpoints`);
    assert.equal(list.status, 200);
    assert.equal((list.body.checkpoints as unknown[]).length, 1);

    const denied = await api(s.port, 'POST', `/api/sessions/${id}/checkpoints`, {
      label: 'evil',
      codeRoot: s.dataDir,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'SESSION_CODE_ROOT_DENIED');
  } finally {
    await stopServer(s);
  }
});

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-cp-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'version one\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

test('restore rolls back code AND session state, with pre-restore safety', async () => {
  const s = await startServer();
  const repo = initGitRepo();
  try {
    const id = await makeSession(s.port, 'rollback demo');
    // Uncommitted change → checkpoint captures it.
    fs.writeFileSync(path.join(repo, 'f.txt'), 'version two\n', 'utf8');
    const cp = await api(s.port, 'POST', `/api/sessions/${id}/checkpoints`, {
      label: 'before-bad-idea',
      codeRoot: repo,
    });
    assert.equal(cp.status, 201);
    assert.ok((cp.body.checkpoint.gitDiff as string).includes('version two'));
    const cid = cp.body.checkpoint.id as string;

    // The world moves on: code reverted by hand, session archived.
    execFileSync('git', ['-C', repo, 'checkout', '--', '.']);
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'version one\n');
    await api(s.port, 'POST', `/api/sessions/${id}/archive`, {});

    // Restore: session back to active AND code diff re-applied.
    const r = await api(s.port, 'POST', `/api/sessions/${id}/checkpoints/${cid}/restore`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.codeApplied, true);
    assert.ok(r.body.preRestoreCheckpointId);
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'version two\n');
    const one = await api(s.port, 'GET', `/api/sessions/${id}`);
    assert.equal(one.body.session.status, 'active');

    // The auto-created pre-restore checkpoint is listed (restore is reversible).
    const list = await api(s.port, 'GET', `/api/sessions/${id}/checkpoints`);
    assert.equal((list.body.checkpoints as unknown[]).length, 2);

    const missing = await api(s.port, 'POST', `/api/sessions/${id}/checkpoints/nope/restore`, {});
    assert.equal(missing.status, 404);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    await stopServer(s);
  }
});
