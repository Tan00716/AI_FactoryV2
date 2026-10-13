/**
 * §17.4 (G-11, Batch 18) — subtask inheritance + the Scope Checker at
 * their real HTTP consumption point, POST /api/tasks/:id/subtasks:
 * inherited facts are visible on the created subtask; a proposal
 * wider than the root is refused 422 with the structured violations
 * and creates nothing; a title-only creation behaves exactly as it
 * did before the checker existed.
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

async function waitHealthy(port: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy in 20s');
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-subscope-http-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      DB_PATH: path.join(dir, 'factory.db'),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitHealthy(port, proc);
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

async function makeProject(port: number): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', {
    name: 'Scope Demo',
    description: 'batch 18',
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  return (project.body as { id: string }).id;
}

test('a subtask created over HTTP carries the root inheritance, visibly', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const root = await api(s.port, 'POST', '/api/tasks', {
      title: 'scoped root',
      projectId: pid,
      requirementRef: 'REQ-001@2',
      acceptanceCriteria: ['AC-1', 'AC-2'],
      policyCeiling: ['fs.read', 'git.commit'],
      budgetEnvelope: { tokens: 1000 },
    });
    assert.equal(root.status, 201, JSON.stringify(root.body));
    const rootId = (root.body as { id: string }).id;
    // The carriers persist on the root itself.
    assert.equal((root.body as { requirementRef: string }).requirementRef, 'REQ-001@2');
    assert.deepEqual((root.body as { policyCeiling: string[] }).policyCeiling, [
      'fs.read',
      'git.commit',
    ]);

    const sub = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'child',
      relation: 'implements the read half of the root goal',
    });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const body = sub.body as {
      requirementRef: string;
      acceptanceCriteria: string[];
      policyCeiling: string[];
      budgetEnvelope: Record<string, number>;
      parentRelation: string;
      authorizationStatus: string;
    };
    assert.equal(body.requirementRef, 'REQ-001@2');
    assert.deepEqual(body.acceptanceCriteria, ['AC-1', 'AC-2']);
    assert.deepEqual(body.policyCeiling, ['fs.read', 'git.commit']);
    assert.deepEqual(body.budgetEnvelope, { tokens: 1000 });
    assert.equal(body.parentRelation, 'implements the read half of the root goal');
    assert.equal(body.authorizationStatus, 'AUTHORIZED');
  } finally {
    await stopServer(s);
  }
});

test('a proposal wider than the root is refused 422 and creates nothing', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const root = await api(s.port, 'POST', '/api/tasks', {
      title: 'scoped root',
      projectId: pid,
      policyCeiling: ['fs.read'],
      budgetEnvelope: { tokens: 100 },
      acceptanceCriteria: ['AC-1'],
    });
    const rootId = (root.body as { id: string }).id;

    const wide = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'too wide',
      relation: 'claims to serve the root goal',
      policyCeiling: ['fs.read', 'shell.execute'],
      budgetEnvelope: { tokens: 101 },
      acceptanceCriteria: ['AC-1', 'AC-OTHER'],
    });
    assert.equal(wide.status, 422, JSON.stringify(wide.body));
    const wb = wide.body as {
      code: string;
      rootTaskId: string;
      violations: { kind: string }[];
    };
    assert.equal(wb.code, 'TASK_SCOPE_VIOLATION');
    assert.equal(wb.rootTaskId, rootId);
    const kinds = wb.violations.map((v) => v.kind);
    assert.ok(kinds.includes('POLICY_CEILING'));
    assert.ok(kinds.includes('BUDGET'));
    assert.ok(kinds.includes('ACCEPTANCE_CRITERIA'));

    // Nothing was created.
    const parent = await api(s.port, 'GET', `/api/tasks/${rootId}`);
    assert.deepEqual(
      (parent.body as { subtaskIds: string[] }).subtaskIds,
      [],
    );

    // A scoped proposal inside the root passes the same gate.
    const narrow = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'inside scope',
      relation: 'the read half of the root goal',
      policyCeiling: ['fs.read'],
      budgetEnvelope: { tokens: 50 },
      acceptanceCriteria: ['AC-1'],
    });
    assert.equal(narrow.status, 201, JSON.stringify(narrow.body));
  } finally {
    await stopServer(s);
  }
});

test('a scope proposal without the §17.4 relation is refused; a plain creation is untouched', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const root = await api(s.port, 'POST', '/api/tasks', {
      title: 'root',
      projectId: pid,
      policyCeiling: ['fs.read'],
    });
    const rootId = (root.body as { id: string }).id;

    const noRelation = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'scoped but silent',
      policyCeiling: ['fs.read'],
    });
    assert.equal(noRelation.status, 422);
    const kinds = (
      noRelation.body as { violations: { kind: string }[] }
    ).violations.map((v) => v.kind);
    assert.ok(kinds.includes('RELATION'));

    // The pre-checker call shape — title only — still just works.
    const plain = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'plain child',
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
  } finally {
    await stopServer(s);
  }
});

test('a subtask under a WAITING root inherits WAITING — never AUTHORIZED', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const root = await api(s.port, 'POST', '/api/tasks', {
      title: 'waiting root',
      projectId: pid,
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    const rootId = (root.body as { id: string }).id;

    const sub = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'child',
    });
    assert.equal(sub.status, 201);
    assert.equal(
      (sub.body as { authorizationStatus: string }).authorizationStatus,
      'WAITING_HUMAN_DISPATCH',
    );

    const greedy = await api(s.port, 'POST', `/api/tasks/${rootId}/subtasks`, {
      title: 'greedy child',
      relation: 'part of the goal',
      authorizationStatus: 'AUTHORIZED',
    });
    assert.equal(greedy.status, 422);
    const kinds = (
      greedy.body as { violations: { kind: string }[] }
    ).violations.map((v) => v.kind);
    assert.ok(kinds.includes('AUTHORIZATION'));
  } finally {
    await stopServer(s);
  }
});
