/**
 * Quality gate HTTP tests — boots the real server (dist) with an
 * isolated DB + data dir:
 *   GET /api/quality?projectId=  → defaults when unconfigured; 400 without
 *   PUT /api/quality             → 400 on invalid input; persists valid config
 *   POST /api/quality/run        → runs the configured command; blocked=true
 *                                   + HIGH notification on blockOnFailure
 *   /lint /test /run slash       → execute via /api/commands/execute
 *   GET /api/commands            → lint/test/run listed as built-ins
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/quality-routes.test.ts
 * (requires `npm run build` first — the server boots from dist).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-quality-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
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
  return { port, proc, dir };
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

function notificationsOf(dir: string): any[] {
  const f = path.join(dir, 'data', 'notifications.json');
  if (!fs.existsSync(f)) return [];
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return raw.notifications ?? [];
}

test('GET /api/quality: 400 without projectId, defaults when unconfigured', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'GET', '/api/quality');
    assert.equal(bad.status, 400);
    const r = await api(s.port, 'GET', '/api/quality?projectId=proj-a');
    assert.equal(r.status, 200);
    assert.equal(r.body.config.lintCmd, '');
    assert.equal(r.body.config.testCmd, '');
    assert.equal(r.body.lastRun.lint, null);
  } finally {
    await stopServer(s);
  }
});

test('PUT /api/quality: 400 on invalid input, persists valid config', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'PUT', '/api/quality', { projectId: 'proj-b', timeoutMs: 0 });
    assert.equal(bad.status, 400);
    const missing = await api(s.port, 'PUT', '/api/quality', { lintCmd: 'true' });
    assert.equal(missing.status, 400);
    const ok = await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-b',
      lintCmd: 'true',
      testCmd: 'false',
      timeoutMs: 5000,
      runOnEdit: true,
      blockOnFailure: true,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.lintCmd, 'true');
    const get = await api(s.port, 'GET', '/api/quality?projectId=proj-b');
    assert.equal(get.body.config.testCmd, 'false');
    assert.equal(get.body.config.blockOnFailure, true);
  } finally {
    await stopServer(s);
  }
});

test('POST /api/quality/run: ok on exit 0; skipped when unconfigured', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'PUT', '/api/quality', { projectId: 'proj-c', lintCmd: 'true' });
    const ok = await api(s.port, 'POST', '/api/quality/run', { projectId: 'proj-c', kind: 'lint' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.skipped, false);
    assert.equal(ok.body.blocked, false);
    const skipped = await api(s.port, 'POST', '/api/quality/run', {
      projectId: 'proj-c',
      kind: 'test',
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.skipped, true);
    const badKind = await api(s.port, 'POST', '/api/quality/run', {
      projectId: 'proj-c',
      kind: 'nope',
    });
    assert.equal(badKind.status, 400);
    // lastRun is recorded and visible via GET.
    const get = await api(s.port, 'GET', '/api/quality?projectId=proj-c');
    assert.equal(get.body.lastRun.lint?.ok, true);
  } finally {
    await stopServer(s);
  }
});

test('POST /api/quality/run: failing gate + blockOnFailure → blocked + HIGH notification', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-d',
      lintCmd: 'false',
      blockOnFailure: true,
    });
    const r = await api(s.port, 'POST', '/api/quality/run', {
      projectId: 'proj-d',
      kind: 'lint',
      runId: 'run-123',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.blocked, true);
    const notes = notificationsOf(s.dir);
    const hit = notes.find((n: any) => n.type === 'QUALITY_GATE_FAILED');
    assert.ok(hit, 'expected a QUALITY_GATE_FAILED notification');
    assert.equal(hit.priority, 'HIGH');
  } finally {
    await stopServer(s);
  }
});

test('slash /lint /test /run execute through /api/commands/execute', async () => {
  const s = await startServer();
  try {
    const list = await api(s.port, 'GET', '/api/commands');
    const names = (list.body.builtins as { name: string }[]).map((b) => b.name);
    assert.ok(names.includes('lint'), 'lint builtin listed');
    assert.ok(names.includes('test'), 'test builtin listed');
    assert.ok(names.includes('run'), 'run builtin listed');

    const noProject = await api(s.port, 'POST', '/api/commands/execute', { input: '/lint' });
    assert.equal(noProject.status, 400);

    await api(s.port, 'PUT', '/api/quality', { projectId: 'proj-e', lintCmd: 'true', testCmd: 'true' });
    const lint = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/lint',
      projectId: 'proj-e',
    });
    assert.equal(lint.status, 200);
    assert.equal(lint.body.type, 'quality-gate');
    assert.equal(lint.body.results[0].ok, true);

    const run = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/run',
      projectId: 'proj-e',
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.results.length, 2);
    assert.deepEqual(
      run.body.results.map((r: any) => r.kind),
      ['lint', 'test'],
    );
  } finally {
    await stopServer(s);
  }
});
