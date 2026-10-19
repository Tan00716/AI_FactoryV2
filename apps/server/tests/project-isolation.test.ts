/**
 * Multi-project isolation tests.
 *
 * Boots the real server (dist) with an isolated DB and proves that two
 * "windows" (two projectIds) hitting the SAME backend process see strictly
 * disjoint data — the property the multi-window feature relies on.
 * No global current-project singleton may leak one window's data into
 * another's.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/project-isolation.test.ts
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-projiso-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not come up');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, proc, dir };
}

async function postJson(base: string, p: string, body: unknown): Promise<any> {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200 && r.status !== 201) {
    const text = await r.text();
    assert.fail(`${p} → ${r.status}: ${text}`);
  }
  return r.json();
}

test('two windows on one backend see disjoint tasks (concurrent)', async () => {
  const running = await startServer();
  try {
    const base = `http://127.0.0.1:${running.port}`;
    const projA = 'proj-myapp'; // seeded
    const created = await postJson(base, '/api/projects', { name: 'Isolation Probe B' });
    const projB: string = created.id;
    assert.ok(projB && projB !== projA, 'second project must have a distinct id');

    const taskA = await postJson(base, '/api/tasks', { projectId: projA, title: 'task-for-A' });
    const taskB = await postJson(base, '/api/tasks', { projectId: projB, title: 'task-for-B' });

    // Two "windows" read concurrently against the same backend process.
    const [listA, listB] = await Promise.all([
      fetch(`${base}/api/tasks?projectId=${encodeURIComponent(projA)}`).then((r) => r.json()),
      fetch(`${base}/api/tasks?projectId=${encodeURIComponent(projB)}`).then((r) => r.json()),
    ]);
    const idsA = new Set((listA as any[]).map((t) => t.id));
    const idsB = new Set((listB as any[]).map((t) => t.id));
    assert.ok(idsA.has(taskA.id), 'window A sees its own task');
    assert.ok(!idsA.has(taskB.id), 'window A must NOT see window B task');
    assert.ok(idsB.has(taskB.id), 'window B sees its own task');
    assert.ok(!idsB.has(taskA.id), 'window B must NOT see window A task');

    // Board endpoint is project-scoped too.
    const [boardA, boardB] = await Promise.all([
      fetch(`${base}/api/board?projectId=${encodeURIComponent(projA)}`).then((r) => r.json()),
      fetch(`${base}/api/board?projectId=${encodeURIComponent(projB)}`).then((r) => r.json()),
    ]);
    const boardIds = (b: any): string[] =>
      Object.values(b.columns ?? {}).flatMap((col: any) => (col as any[]).map((c) => c.id));
    assert.ok(boardIds(boardA).includes(taskA.id));
    assert.ok(!boardIds(boardA).includes(taskB.id));
    assert.ok(boardIds(boardB).includes(taskB.id));
    assert.ok(!boardIds(boardB).includes(taskA.id));
  } finally {
    running.proc.kill('SIGKILL');
    fs.rmSync(running.dir, { recursive: true, force: true });
  }
});

test('unknown ?project= id in a window falls back safely (no 500)', async () => {
  const running = await startServer();
  try {
    const base = `http://127.0.0.1:${running.port}`;
    // A window bound to a nonexistent project gets an empty list, not an error.
    const r = await fetch(`${base}/api/tasks?projectId=${encodeURIComponent('proj-nope-zzz')}`);
    assert.equal(r.status, 200);
    const list = (await r.json()) as any[];
    assert.deepEqual(list, []);
  } finally {
    running.proc.kill('SIGKILL');
    fs.rmSync(running.dir, { recursive: true, force: true });
  }
});
