/**
 * Shadow checkpoint HTTP tests — boots the real server (dist) with an
 * isolated DB + data dir:
 *   PUT   /api/shadow-checkpoints/config   → registers path + toggles; 400 on bad input
 *   POST  /api/shadow-checkpoints          → 201 snapshot; 400 on path escape
 *   GET   /api/shadow-checkpoints?workspaceId= → list + config
 *   GET   /api/shadow-checkpoints/:id/diff → unified diff vs parent
 *   GET   /api/shadow-checkpoints/task-diff → task-scoped diff
 *   POST  /api/shadow-checkpoints/:id/restore → undo with backup
 *   audit log contains SHADOW_CHECKPOINT_CREATED / RESTORED
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/shadow-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-shadow-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SHADOW_ROOTS: dir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Wait for the port to accept.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, proc, dir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
}

async function api(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('shadow checkpoint HTTP lifecycle', async () => {
  const srv = await startServer();
  try {
    const ws = path.join(srv.dir, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');

    // 1. config: register workspace + toggles
    let r = await api(srv.port, 'PUT', '/api/shadow-checkpoints/config', {
      workspaceId: 'ws1',
      workspacePath: ws,
      autoOnToolUse: false,
      autoOnRunStart: false,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.config.workspacePath, ws);

    // 2. config rejects path escape
    r = await api(srv.port, 'PUT', '/api/shadow-checkpoints/config', {
      workspaceId: 'ws1',
      workspacePath: '/etc',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'SHADOW_PATH_ESCAPE');

    // 3. manual snapshot
    r = await api(srv.port, 'POST', '/api/shadow-checkpoints', {
      workspaceId: 'ws1',
      workspacePath: ws,
      taskId: 'task-1',
      label: 'before work',
    });
    assert.equal(r.status, 201);
    const c1 = r.body.checkpoint.id;
    assert.equal(r.body.checkpoint.taskId, 'task-1');

    // 4. change + second snapshot
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\nv2\n');
    r = await api(srv.port, 'POST', '/api/shadow-checkpoints', {
      workspaceId: 'ws1',
      workspacePath: ws,
      taskId: 'task-1',
      label: 'after work',
    });
    assert.equal(r.status, 201);
    const c2 = r.body.checkpoint.id;

    // 5. list
    r = await api(srv.port, 'GET', '/api/shadow-checkpoints?workspaceId=ws1');
    assert.equal(r.status, 200);
    assert.equal(r.body.checkpoints.length, 2);
    assert.ok(r.body.config);

    // 6. diff of second checkpoint vs parent
    r = await api(srv.port, 'GET', `/api/shadow-checkpoints/${c2}/diff?workspaceId=ws1`);
    assert.equal(r.status, 200);
    assert.ok(r.body.diff.includes('+v2'));
    assert.equal(r.body.files[0].path, 'a.txt');

    // 7. task-scoped diff
    r = await api(srv.port, 'GET', '/api/shadow-checkpoints/task-diff?workspaceId=ws1&taskId=task-1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.checkpoints.sort(), [c1, c2].sort());
    assert.ok(r.body.diff.includes('+v2'));

    // 8. undo → restores v1, takes pre-restore backup
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\nv2\nv3-uncommitted\n');
    r = await api(srv.port, 'POST', `/api/shadow-checkpoints/${c1}/restore`, {
      workspaceId: 'ws1',
      workspacePath: ws,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.restoredId, c1);
    assert.ok(r.body.backup, 'unsnapshotted v3 state must be backed up');
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');

    // 9. audit trail records the lifecycle (GET /api/audit → array, latest first)
    r = await api(srv.port, 'GET', '/api/audit?limit=50');
    assert.equal(r.status, 200);
    const actions = (Array.isArray(r.body) ? r.body : []).map((e: any) => e.action ?? e.type);
    assert.ok(actions.includes('SHADOW_CHECKPOINT_CREATED'), `audit actions: ${actions.slice(0, 10)}`);
    assert.ok(actions.includes('SHADOW_CHECKPOINT_RESTORED'));

    // 10. unknown checkpoint → 404
    r = await api(srv.port, 'POST', '/api/shadow-checkpoints/scp_nope/restore', {
      workspaceId: 'ws1',
      workspacePath: ws,
    });
    assert.equal(r.status, 404);
  } finally {
    await stopServer(srv);
  }
});
