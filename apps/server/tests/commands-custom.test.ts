/**
 * Custom slash commands (R6-A7) — HTTP tests on the real server (dist).
 *
 * Boots the real server with an isolated DB + data dir and
 * FACTORY_INSPECT_ROOTS pointed at a fixture project dir containing
 * .ai-factory/tasks.json:
 *   task binding: /t runs a tasks.json chain with slash args appended
 *     to the REQUESTED task only (dependencies keep declared args)
 *   command binding: execute returns a { commandId, args } descriptor
 *     for the desktop to dispatch (the server runs no desktop command)
 *   enable/disable: disabled commands list but refuse execution (409)
 *   scopes: project overrides user; builtin shadow needs override: true
 *     and surfaces a warning; removing the shadow restores the builtin
 *   validation + project-root jail (403 on escape)
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/commands-custom.test.ts
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
  proj: string;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-commands-custom-'));
  // NB: the project dir must NOT live under the DB dir — the exec guard
  // denies any task whose cwd is inside the control-plane data dir.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-commands-proj-'));
  fs.mkdirSync(path.join(proj, '.ai-factory'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.ai-factory', 'tasks.json'),
    JSON.stringify({
      version: '1',
      tasks: [
        { label: 'dep', type: 'shell', command: 'echo', args: ['dep-out'] },
        { label: 'say', type: 'shell', command: 'echo', args: ['hello'], dependsOn: ['dep'] },
      ],
    }),
    'utf8',
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_INSPECT_ROOTS: proj,
    // R17 #6(k): task runs are fail-closed without bwrap; this test
    // exercises the chain itself, so it opts out explicitly.
    FACTORY_EXEC_SANDBOX: '0',
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
  return { port, proc, dir, proj };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
  fs.rmSync(s.proj, { recursive: true, force: true });
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

test('task binding runs the chain with slash args on the requested task only', async () => {
  const s = await startServer();
  try {
    const add = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 't',
      kind: 'task',
      target: 'say',
      template: '{args}',
      description: 'Say it with args',
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));

    const exec = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/t brave new',
      root: s.proj,
    });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.type, 'task');
    assert.equal(exec.body.label, 'say');
    assert.deepEqual(exec.body.expandedArgs, ['brave', 'new']);
    assert.equal(exec.body.chain.ok, true);
    const byLabel = new Map(
      (exec.body.chain.results as { label: string; output: string }[]).map((r) => [r.label, r.output]),
    );
    assert.match(byLabel.get('say') ?? '', /hello brave new/);
    // Dependency runs with declared args only — no slash args leak.
    assert.match(byLabel.get('dep') ?? '', /dep-out/);
    assert.doesNotMatch(byLabel.get('dep') ?? '', /brave/);
  } finally {
    await stopServer(s);
  }
});

test('command binding returns a dispatch descriptor; template still expands', async () => {
  const s = await startServer();
  try {
    const add = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'goto',
      kind: 'command',
      target: 'go.tab.editor',
      template: '{args}',
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));

    const exec = await api(s.port, 'POST', '/api/commands/execute', { input: '/goto foo' });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.type, 'command');
    assert.equal(exec.body.commandId, 'go.tab.editor');
    assert.equal(exec.body.args, 'foo');

    const bad = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'badcmd',
      kind: 'command',
      target: 'not a command id!',
    });
    assert.equal(bad.status, 400);
    const noTarget = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'notask',
      kind: 'task',
    });
    assert.equal(noTarget.status, 400);
  } finally {
    await stopServer(s);
  }
});

test('disable refuses execution; enable restores it; update edits', async () => {
  const s = await startServer();
  try {
    const add = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'note',
      template: 'Note: {args}',
    });
    assert.equal(add.status, 201);

    const off = await api(s.port, 'POST', '/api/commands', { op: 'disable', name: 'note' });
    assert.equal(off.status, 200);
    assert.equal(off.body.command.enabled, false);

    const blocked = await api(s.port, 'POST', '/api/commands/execute', { input: '/note hi' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /disabled/);

    const listed = await api(s.port, 'GET', '/api/commands');
    const entry = (listed.body.custom as { name: string; enabled: boolean }[]).find((c) => c.name === 'note');
    assert.equal(entry?.enabled, false, 'disabled commands still list');

    const on = await api(s.port, 'POST', '/api/commands', { op: 'enable', name: 'note' });
    assert.equal(on.status, 200);
    const exec = await api(s.port, 'POST', '/api/commands/execute', { input: '/note hi' });
    assert.equal(exec.status, 200);
    assert.equal(exec.body.text, 'Note: hi');

    const upd = await api(s.port, 'POST', '/api/commands', {
      op: 'update',
      name: 'note',
      template: 'Updated: {args}',
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.command.template, 'Updated: {args}');
    const exec2 = await api(s.port, 'POST', '/api/commands/execute', { input: '/note hi' });
    assert.equal(exec2.body.text, 'Updated: hi');
  } finally {
    await stopServer(s);
  }
});

test('project overrides user; builtin shadow needs override and warns', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'standup',
      template: 'user version: {args}',
    });
    const projAdd = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'standup',
      scope: 'project',
      root: s.proj,
      template: 'project version: {args}',
    });
    assert.equal(projAdd.status, 201, JSON.stringify(projAdd.body));

    const listed = await api(s.port, 'GET', `/api/commands?root=${encodeURIComponent(s.proj)}`);
    const entry = (listed.body.custom as { name: string; source: string; shadowsUser: boolean }[]).find(
      (c) => c.name === 'standup',
    );
    assert.equal(entry?.source, 'project');
    assert.equal(entry?.shadowsUser, true);
    assert.ok(
      (listed.body.warnings as string[]).some((w) => w.includes('/standup') && w.includes('project')),
      JSON.stringify(listed.body.warnings),
    );
    const exec = await api(s.port, 'POST', '/api/commands/execute', {
      input: '/standup x',
      root: s.proj,
    });
    assert.equal(exec.body.text, 'project version: x');

    // Built-in clash without override is still 409 (legacy behavior).
    const clash = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'plan',
      template: 'shadow plan: {args}',
    });
    assert.equal(clash.status, 409);

    // With explicit override the shadow wins, with a warning attached.
    const shadow = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'plan',
      template: 'shadow plan: {args}',
      override: true,
    });
    assert.equal(shadow.status, 201);
    assert.match(shadow.body.warning, /shadows built-in/);
    const shadowExec = await api(s.port, 'POST', '/api/commands/execute', { input: '/plan hello' });
    assert.equal(shadowExec.status, 200);
    assert.equal(shadowExec.body.type, 'template');
    assert.equal(shadowExec.body.text, 'shadow plan: hello');
    assert.match(shadowExec.body.warning, /shadowed/);

    // Removing the shadow restores the built-in (usage error proves it).
    const rm = await api(s.port, 'POST', '/api/commands', { op: 'remove', name: 'plan' });
    assert.equal(rm.status, 200);
    const restored = await api(s.port, 'POST', '/api/commands/execute', { input: '/plan' });
    assert.equal(restored.status, 400);
    assert.match(restored.body.error, /usage: \/plan/);
  } finally {
    await stopServer(s);
  }
});

test('project scope escapes the jail with 403', async () => {
  const s = await startServer();
  try {
    const esc = await api(s.port, 'POST', '/api/commands', {
      op: 'add',
      name: 'evil',
      scope: 'project',
      root: '/etc',
      template: 'x',
    });
    assert.equal(esc.status, 403, JSON.stringify(esc.body));
  } finally {
    await stopServer(s);
  }
});
