/**
 * Plan mode HTTP tests (W-B) — the plan/execute split over real HTTP.
 *
 * Boots the real server (dist) with an isolated DB + data dir:
 *   POST /api/plans → 201 + PENDING plan + §23.3 approval ticket bound
 *     to the plan content digest
 *   GET /api/plans / :id → list/get
 *   POST /api/plans/:id/approve → approval ticket APPROVED, plan APPROVED
 *   POST /api/plans/:id/execute → EXECUTING; POST .../finish → DONE
 *   POST /api/plans/:id/reject → ticket REJECTED, plan REJECTED (reason required)
 *   validation: empty title / empty steps → 400; double approve → 409
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/plan-mode.test.ts
 * (server must be built first: npm run build -w @ai-factory/server)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-plan-mode-'));
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

const PLAN = {
  title: 'Add plan mode',
  goal: 'Let agents propose plans for human approval before executing.',
  steps: [
    { title: 'Explore the codebase (read-only)' },
    { title: 'Draft the plan', detail: 'steps with acceptance criteria' },
    { title: 'Implement after approval' },
  ],
};

async function makeTask(port: number): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', { name: 'Plan Demo' });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectId = (project.body as { id: string }).id;
  const task = await api(port, 'POST', '/api/tasks', {
    title: 'plan target',
    projectId,
    authorizationStatus: 'DRAFT',
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  return (task.body as { id: string }).id;
}

test('plan lifecycle: create → approve → execute → finish', async () => {
  const s = await startServer();
  try {
    const taskId = await makeTask(s.port);
    const created = await api(s.port, 'POST', '/api/plans', { ...PLAN, taskId, createdBy: 'tester' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const plan = created.body.plan;
    const approval = created.body.approval;
    assert.equal(plan.status, 'PENDING');
    assert.equal(plan.steps.length, 3);
    assert.ok(plan.id);
    assert.ok(plan.contentDigest, 'plan binds a content digest');
    assert.equal(plan.approvalId, approval.approval_id);
    assert.equal(approval.status, 'PENDING');
    assert.equal(approval.action, 'plan.execute');
    assert.equal(approval.candidate_digest, plan.contentDigest, 'ticket binds the plan content');

    const listed = await api(s.port, 'GET', '/api/plans?status=PENDING');
    assert.equal(listed.status, 200);
    assert.ok((listed.body.plans as unknown[]).some((p: any) => p.id === plan.id));

    const got = await api(s.port, 'GET', `/api/plans/${plan.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.plan.id, plan.id);
    assert.equal(got.body.approval.approval_id, approval.approval_id);

    const approved = await api(s.port, 'POST', `/api/plans/${plan.id}/approve`, {
      decidedBy: 'human',
      reason: 'looks good',
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.plan.status, 'APPROVED');
    assert.equal(approved.body.approval.status, 'APPROVED');

    // Double approve → 409 (plan no longer PENDING / ticket no longer pending).
    const again = await api(s.port, 'POST', `/api/plans/${plan.id}/approve`, { decidedBy: 'human' });
    assert.equal(again.status, 409);

    const exec = await api(s.port, 'POST', `/api/plans/${plan.id}/execute`, {});
    assert.equal(exec.status, 200);
    assert.equal(exec.body.plan.status, 'EXECUTING');

    const done = await api(s.port, 'POST', `/api/plans/${plan.id}/finish`, { done: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.plan.status, 'DONE');
  } finally {
    await stopServer(s);
  }
});

test('reject requires a reason and mirrors onto the plan', async () => {
  const s = await startServer();
  try {
    const taskId = await makeTask(s.port);
    const created = await api(s.port, 'POST', '/api/plans', { ...PLAN, taskId });
    assert.equal(created.status, 201);
    const id = created.body.plan.id as string;

    const noReason = await api(s.port, 'POST', `/api/plans/${id}/reject`, {});
    assert.equal(noReason.status, 400);

    const rejected = await api(s.port, 'POST', `/api/plans/${id}/reject`, {
      decidedBy: 'human',
      reason: 'too risky',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.plan.status, 'REJECTED');
    assert.equal(rejected.body.plan.decisionReason, 'too risky');
    assert.equal(rejected.body.approval.status, 'REJECTED');

    // A rejected plan cannot execute.
    const exec = await api(s.port, 'POST', `/api/plans/${id}/execute`, {});
    assert.equal(exec.status, 409);
  } finally {
    await stopServer(s);
  }
});

test('validation: title, steps and taskId required; unknown plan → 404', async () => {
  const s = await startServer();
  try {
    const taskId = await makeTask(s.port);
    const noTitle = await api(s.port, 'POST', '/api/plans', { taskId, steps: [{ title: 'x' }] });
    assert.equal(noTitle.status, 400);
    const noSteps = await api(s.port, 'POST', '/api/plans', { taskId, title: 'x', steps: [] });
    assert.equal(noSteps.status, 400);
    const noTask = await api(s.port, 'POST', '/api/plans', {
      title: 'x',
      steps: [{ title: 'y' }],
    });
    assert.equal(noTask.status, 400);
    const badTask = await api(s.port, 'POST', '/api/plans', {
      taskId: 'task-does-not-exist',
      title: 'x',
      steps: [{ title: 'y' }],
    });
    assert.equal(badTask.status, 404);
    const missing = await api(s.port, 'GET', '/api/plans/does-not-exist');
    assert.equal(missing.status, 404);
    const approveMissing = await api(s.port, 'POST', '/api/plans/does-not-exist/approve', {});
    assert.equal(approveMissing.status, 404);
  } finally {
    await stopServer(s);
  }
});
