/**
 * Walkthrough: the v1 transition endpoint checks the §17.2 authorization axis (Batch 75, F61).
 *
 * SPEC_V2 §17.2: "创建不等于执行授权" — a task's authorization_status axis is
 * independent of its workflow state. §18.2: the Workflow Engine checks
 * Authorization as part of the transition contract ("Workflow Engine 在事务中
 * 检查 Task Version、Authorization、…" and "Human 不绕过不变量").
 *
 * What this pins, end to end (real compiled server process, pure HTTP,
 * zero mocks, fresh temp SQLite):
 *
 *   A. A task created with no explicit authorizationStatus (the legacy
 *      shape, axis absent) still transitions fine — the axis reads
 *      AUTHORIZED and the legacy path is unchanged.
 *   B. A WAITING_HUMAN_DISPATCH task (AI-discovered-problem path) is
 *      refused by POST /api/tasks/:id/transition with 403
 *      TASK_NOT_AUTHORIZED; the body carries the observed
 *      authorizationStatus and the DB row is untouched.
 *   C. A REVOKED task is refused the same way (403, row untouched).
 *   D. The loop closes the human way: dispatch via=HUMAN moves a waiting
 *      task to AUTHORIZED and the transition then succeeds — the same
 *      shape as the G5 run gate (Batch 17).
 *
 * Fail-closed: only the AUTHORIZED axis passes; any other (or unknown)
 * value refuses. This is the v1 endpoint the desktop Board drags on, so
 * the Board now needs a Human Dispatch before dragging an unauthorized
 * task — recorded in docs/KNOWN_LIMITATIONS.md (§17.2 entry, Batch 75).
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch only, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

/** Boot the real server against the given DB file (real startup path). */
async function bootServer(
  dir: string,
  dbFile: string,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault + project root (fail-closed without them).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  delete env['FACTORY_GIT_BROKER_ACTIONS'];
  // Keep the boot clean of test-runner context (production never has it).
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Stop the server and wait for the process to actually exit. */
async function stopServer(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

async function makeProject(port: number): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', { name: 'b75-f61' });
  assert.equal(project.status, 201, 'project created');
  return project.json['id'] as string;
}

async function makeTask(
  port: number,
  projectId: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const task = await api(port, 'POST', '/api/tasks', {
    projectId,
    title: 'b75 task',
    ...extra,
  });
  assert.equal(task.status, 201, 'task created');
  return task.json['id'] as string;
}

describe('v1 /transition checks the §17.2 authorization axis (F61)', () => {
  it('A: legacy-shaped task (no axis value) still transitions — legacy path unchanged', async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine; see F45).
    const dir = mkdtempSync(join(homedir(), 'b75-f61-a-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const projectId = await makeProject(port);
      const taskId = await makeTask(port, projectId);
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'PLANNING',
        actor: 'human',
      });
      assert.equal(r.status, 200, 'AUTHORIZED-by-default task transitions');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'PLANNING', 'state moved');
    } finally {
      await stopServer(child);
    }
  });

  it('B: WAITING_HUMAN_DISPATCH task is refused — 403 TASK_NOT_AUTHORIZED, row untouched', async () => {
    const dir = mkdtempSync(join(homedir(), 'b75-f61-b-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const projectId = await makeProject(port);
      const taskId = await makeTask(port, projectId, {
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'PLANNING',
        actor: 'human',
      });
      assert.equal(r.status, 403, 'waiting task must be refused');
      assert.equal(r.json['code'], 'TASK_NOT_AUTHORIZED');
      assert.equal(r.json['authorizationStatus'], 'WAITING_HUMAN_DISPATCH');
      assert.match(String(r.json['error']), /§17\.2/);
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'TODO', 'refused transition leaves the row untouched');
    } finally {
      await stopServer(child);
    }
  });

  it('C: REVOKED task is refused the same way', async () => {
    const dir = mkdtempSync(join(homedir(), 'b75-f61-c-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const projectId = await makeProject(port);
      const taskId = await makeTask(port, projectId);
      const revoked = await api(port, 'POST', `/api/tasks/${taskId}/revoke-authorization`, {
        actor: 'human',
      });
      assert.equal(revoked.status, 200, 'revoke lands');
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'PLANNING',
        actor: 'human',
      });
      assert.equal(r.status, 403, 'revoked task must be refused');
      assert.equal(r.json['code'], 'TASK_NOT_AUTHORIZED');
      assert.equal(r.json['authorizationStatus'], 'REVOKED');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'TODO', 'refused transition leaves the row untouched');
    } finally {
      await stopServer(child);
    }
  });

  it('D: Human Dispatch re-authorizes — the transition then succeeds', async () => {
    const dir = mkdtempSync(join(homedir(), 'b75-f61-d-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const projectId = await makeProject(port);
      const taskId = await makeTask(port, projectId, {
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
      const dispatched = await api(port, 'POST', `/api/tasks/${taskId}/dispatch`, {
        via: 'HUMAN',
        actor: 'human',
      });
      assert.equal(dispatched.status, 200, 'human dispatch lands');
      assert.equal(dispatched.json['to'], 'AUTHORIZED');
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'PLANNING',
        actor: 'human',
      });
      assert.equal(r.status, 200, 'authorized task transitions after dispatch');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'PLANNING', 'state moved');
    } finally {
      await stopServer(child);
    }
  });
});
