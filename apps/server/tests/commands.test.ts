/**
 * Slash command HTTP tests (W-B).
 *
 * Boots the real server (dist) with an isolated DB + data dir:
 *   GET /api/commands → built-ins (/help /plan /review) listed
 *   POST /api/commands/execute {input:"/help"} → help payload
 *   POST /api/commands/execute {input:"/plan <goal>"} → 201 + PENDING plan
 *   POST /api/commands/execute {input:"/review"} → dimensions guidance
 *   custom: POST /api/commands {op:'add'} → execute expands {args}/{args:N}
 *   POST /api/commands {op:'remove'} → gone
 *   unknown command → 404; missing leading slash → 400
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/commands.test.ts
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-commands-'));
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

test('GET /api/commands lists built-ins', async () => {
  const s = await startServer();
  try {
    const r = await api(s.port, 'GET', '/api/commands');
    assert.equal(r.status, 200);
    const names = (r.body.builtins as { name: string }[]).map((b) => b.name).sort();
    assert.deepEqual(names, ['help', 'lint', 'map', 'map-refresh', 'plan', 'providers', 'review', 'run', 'test']);
  } finally {
    await stopServer(s);
  }
});

test('/help and /review execute', async () => {
  const s = await startServer();
  try {
    const help = await api(s.port, 'POST', '/api/commands/execute', { input: '/help' });
    assert.equal(help.status, 200);
    assert.equal(help.body.type, 'help');
    assert.ok(Array.isArray(help.body.builtins));

    const review = await api(s.port, 'POST', '/api/commands/execute', { input: '/review' });
    assert.equal(review.status, 200);
    assert.equal(review.body.type, 'review');
    assert.ok(review.body.reviewEndpoint);
  } finally {
    await stopServer(s);
  }
});

test('/plan creates a PENDING plan-mode plan for a task', async () => {
  const s = await startServer();
  try {
    const project = await api(s.port, 'POST', '/api/projects', { name: 'Cmd Demo' });
    assert.equal(project.status, 201);
    const projectId = (project.body as { id: string }).id;
    const task = await api(s.port, 'POST', '/api/tasks', {
      title: 'cmd target',
      projectId,
      authorizationStatus: 'DRAFT',
    });
    assert.equal(task.status, 201);
    const taskId = (task.body as { id: string }).id;

    const r = await api(s.port, 'POST', '/api/commands/execute', {
      input: `/plan ${taskId} Add dark mode to the settings page`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.type, 'plan');
    assert.equal(r.body.plan.status, 'PENDING');
    assert.equal(r.body.plan.taskId, taskId);
    assert.ok(r.body.plan.goal.includes('dark mode'));
    assert.ok(r.body.approval.approval_id);

    const noTask = await api(s.port, 'POST', '/api/commands/execute', { input: '/plan just a goal' });
    assert.equal(noTask.status, 404, 'first token is the taskId; unknown task → 404');
    const noArgs = await api(s.port, 'POST', '/api/commands/execute', { input: '/plan' });
    assert.equal(noArgs.status, 400);
    const badTask = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/plan task-nope some goal',
    });
    assert.equal(badTask.status, 404);
  } finally {
    await stopServer(s);
  }
});

test('custom commands: add → execute with template expansion → remove', async () => {
  const s = await startServer();
  try {
    const add = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'standup',
      description: 'Standup note',
      template: 'Write a standup note about: {args}. Focus area: {args:1}.',
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));

    // Built-in names are protected.
    const clash = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'plan',
      template: 'x',
    });
    assert.equal(clash.status, 409);

    const exec = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/standup auth refactor',
    });
    assert.equal(exec.status, 200);
    assert.equal(exec.body.type, 'template');
    assert.equal(
      exec.body.text,
      'Write a standup note about: auth refactor. Focus area: auth.',
    );

    const listed = await api(s.port, 'GET', '/api/commands');
    assert.ok((listed.body.custom as { name: string }[]).some((c) => c.name === 'standup'));

    const remove = await api(s.port, 'POST', '/api/commands', { op: 'remove', name: 'standup' });
    assert.equal(remove.status, 200);

    const gone = await api(s.port, 'POST', '/api/commands/execute', { input: '/standup x' });
    assert.equal(gone.status, 404);
  } finally {
    await stopServer(s);
  }
});

test('unknown command → 404; non-slash input → 400', async () => {
  const s = await startServer();
  try {
    const unknown = await api(s.port, 'POST', '/api/commands/execute', { input: '/nope' });
    assert.equal(unknown.status, 404);
    const plain = await api(s.port, 'POST', '/api/commands/execute', { input: 'hello' });
    assert.equal(plain.status, 400);
    const empty = await api(s.port, 'POST', '/api/commands/execute', {});
    assert.equal(empty.status, 400);
  } finally {
    await stopServer(s);
  }
});
