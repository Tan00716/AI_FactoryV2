/**
 * @-context providers HTTP tests (task ⑥) — boots the real server (dist)
 * with an isolated DB + data dir:
 *   GET  /api/context-providers            → the five provider metas
 *   POST /api/context-providers/resolve     → dry-run resolution; 400 on unknown provider
 *   POST /api/context-providers/open-files → registry for @open
 *   POST /api/runtime/runs (script with @tree) → 202; run evidence carries
 *        the resolved context; audit carries CONTEXT_PROVIDER_USED
 *   POST /api/runtime/runs (script with @nope) → 400 UNKNOWN_PROVIDER,
 *        and no run record is created
 *   /providers slash → lists the five providers
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/context-providers-http.test.ts
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

/** A workspace root the server may jail @tree/@diff into (with one file). */
function makeWorkspaceRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ctx-ws-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  return dir;
}

async function startServer(workspaceRoot: string): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ctx-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: workspaceRoot,
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

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeAgentAndTask(s: Running): Promise<{ agentId: string; taskId: string; projectId: string }> {
  const project = await api(s, 'POST', '/api/projects', { name: 'ctx-providers' });
  assert.equal(project.status, 201);
  const agent = await api(s, 'POST', '/api/agents', { name: 'ctx', jobTitle: 'Engineer' });
  assert.equal(agent.status, 201);
  const task = await api(s, 'POST', '/api/tasks', {
    projectId: project.body['id'],
    title: 'ctx run',
  });
  assert.equal(task.status, 201);
  // Authorize the task for execution (§17.2). New tasks may arrive
  // already AUTHORIZED (sibling waves changed the default) or as DRAFT;
  // handle both so this helper is robust to either default.
  const created = await api(s, 'GET', `/api/tasks/${task.body['id']}`);
  const authStatus = created.body['authorizationStatus'] ?? created.body['authorization_status'];
  if (authStatus === 'DRAFT') {
    assert.equal((await api(s, 'POST', `/api/tasks/${task.body['id']}/request-dispatch`, {})).status, 200);
    const dispatched = await api(s, 'POST', `/api/tasks/${task.body['id']}/dispatch`, { via: 'HUMAN' });
    assert.equal(dispatched.status, 200);
  } else {
    assert.equal(authStatus, 'AUTHORIZED', `expected AUTHORIZED or DRAFT, got ${authStatus}`);
  }
  return { agentId: agent.body['id'], taskId: task.body['id'], projectId: project.body['id'] };
}

test('GET /api/context-providers lists the five providers', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const r = await api(s, 'GET', '/api/context-providers');
    assert.equal(r.status, 200);
    const names = (r.body['providers'] as { name: string }[]).map((p) => p.name).sort();
    assert.deepEqual(names, ['diff', 'open', 'problems', 'terminal', 'tree']);
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('POST /api/context-providers/resolve: @tree dry-run + @unknown 400', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const ok = await api(s, 'POST', '/api/context-providers/resolve', { text: 'look at @tree' });
    assert.equal(ok.status, 200);
    assert.ok((ok.body['text'] as string).includes('<context provider="tree"'));
    assert.ok((ok.body['text'] as string).includes('hello.txt'));
    assert.equal((ok.body['resolved'] as unknown[]).length, 1);

    const bad = await api(s, 'POST', '/api/context-providers/resolve', { text: 'look at @nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body['error'], 'UNKNOWN_PROVIDER');
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('POST /api/context-providers/resolve: root jail escape is 403', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const r = await api(s, 'POST', '/api/context-providers/resolve', { text: 'x @tree(/etc) y' });
    assert.equal(r.status, 403);
    assert.equal(r.body['error'], 'ROOT_DENIED');
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('POST /api/context-providers/open-files feeds @open', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const reg = await api(s, 'POST', '/api/context-providers/open-files', {
      files: ['/ws/src/a.ts', '/ws/README.md'],
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body['count'], 2);
    const r = await api(s, 'POST', '/api/context-providers/resolve', { text: 'open: @open' });
    assert.equal(r.status, 200);
    assert.ok((r.body['text'] as string).includes('/ws/src/a.ts'));
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('run creation with @tree: 202, context in evidence, audit CONTEXT_PROVIDER_USED', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const { agentId, taskId } = await makeAgentAndTask(s);
    const run = await api(s, 'POST', '/api/runtime/runs', {
      agentId,
      taskId,
      script: [{ text: 'summarize @tree for me', toolCalls: [] }],
    });
    assert.equal(run.status, 202);
    const runId = run.body['id'] as string;

    // The stub adapter replays the (context-enriched) script text.
    const rec = await api(s, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(rec.status, 200);
    const evidence = rec.body['evidence'] as { type: string; payload?: { contexts?: { provider: string; text: string }[] } }[];
    const ctxEv = evidence.find((e) => e.type === 'context_provider');
    assert.ok(ctxEv, 'run evidence carries the attached context');
    assert.equal(ctxEv?.payload?.contexts?.[0]?.provider, 'tree');
    assert.ok((ctxEv?.payload?.contexts?.[0]?.text as string).includes('hello.txt'));

    const audit = await api(s, 'GET', '/api/audit?limit=1000');
    assert.equal(audit.status, 200);
    const rows = audit.body as { action: string; entityId: string }[];
    assert.ok(
      rows.some((e) => e.action === 'CONTEXT_PROVIDER_USED' && e.entityId === runId),
      'CONTEXT_PROVIDER_USED is on the audit record',
    );
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('run creation with @unknown: 400 and no run record created', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const { agentId, taskId } = await makeAgentAndTask(s);
    const before = await api(s, 'GET', '/api/runtime/runs');
    const beforeCount = (before.body['runs'] ?? before.body ?? []) as unknown[];
    const bad = await api(s, 'POST', '/api/runtime/runs', {
      agentId,
      taskId,
      script: [{ text: 'use @frobnicate now', toolCalls: [] }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body['code'], 'UNKNOWN_PROVIDER');
    const after = await api(s, 'GET', '/api/runtime/runs');
    const afterCount = (after.body['runs'] ?? after.body ?? []) as unknown[];
    assert.equal(
      (afterCount as unknown[]).length,
      (beforeCount as unknown[]).length,
      'a refused run leaves no run record behind',
    );
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('/providers slash lists the five providers', async () => {
  const ws = makeWorkspaceRoot();
  const s = await startServer(ws);
  try {
    const r = await api(s, 'POST', '/api/commands/execute', { input: '/providers' });
    assert.equal(r.status, 200);
    assert.equal(r.body['type'], 'providers');
    const names = (r.body['providers'] as { name: string }[]).map((p) => p.name).sort();
    assert.deepEqual(names, ['diff', 'open', 'problems', 'terminal', 'tree']);
  } finally {
    await stopServer(s);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
