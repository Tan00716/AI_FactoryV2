/**
 * Walkthrough: Board drag goes through the same Transition API (Batch 64, G1 / INV-03).
 *
 * SPEC_V2 §18.2: "无权直接写状态字段；Board 拖拽也调用同一 Transition API，
 * Human 不绕过不变量。"
 *
 * What this pins, end to end (real compiled server process, pure HTTP,
 * zero mocks, fresh temp SQLite):
 *
 *   A. There is no bare state-write path: POST /api/tasks/:id/transition
 *      with a body that carries `status`/`stage` but no `to` is rejected
 *      with 400 — the endpoint only understands the Transition API's
 *      { to, actor } contract.
 *   B. Extra `status`/`stage` fields smuggled next to a legal `to` are
 *      ignored: the task's state follows `to` only.
 *   C. The exact payload the desktop Board drag sends
 *      (apps/desktop/src/components/Board.tsx:162 → api.transition →
 *      POST /tasks/:id/transition { to, actor: 'human' }) succeeds
 *      against the same endpoint — the drag path IS the Transition API.
 *   D. No read/bypass route exists: GET and PUT on /transition are not
 *      routed (404).
 *   E. An illegal jump (TODO → DONE, no such edge) is refused with 422
 *      UNKNOWN_TRANSITION, the DB row is untouched, and a
 *      WORKFLOW_TRANSITION_DENIED audit record is written.
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

interface AuditRecord {
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

async function auditRecords(port: number): Promise<AuditRecord[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit?limit=200`);
  assert.equal(res.status, 200, 'GET /api/audit');
  const list = (await res.json()) as unknown;
  assert.ok(Array.isArray(list), '/api/audit returns a bare array');
  return list as AuditRecord[];
}

async function makeTask(port: number): Promise<{ projectId: string; taskId: string }> {
  const project = await api(port, 'POST', '/api/projects', { name: 'g1-board-drag' });
  assert.equal(project.status, 201, 'project created');
  const projectId = project.json['id'] as string;
  const task = await api(port, 'POST', '/api/tasks', {
    projectId,
    title: 'drag me',
  });
  assert.equal(task.status, 201, 'task created');
  assert.equal(task.json['status'], 'TODO', 'new tasks start at TODO');
  return { projectId, taskId: task.json['id'] as string };
}

describe('board drag goes through the same Transition API (G1 / INV-03)', () => {
  it('A: a bare status/stage write without `to` is rejected — no direct state-write path', async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine; see F45).
    const dir = mkdtempSync(join(homedir(), 'g1-drag-a-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const { taskId } = await makeTask(port);
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        status: 'DONE',
        stage: 'DONE',
      });
      assert.equal(r.status, 400, 'transition without `to` must be 400');
      assert.match(String(r.json['error']), /to \(target state\) is required/);
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'TODO', 'state untouched by the rejected write');
    } finally {
      await stopServer(child);
    }
  });

  it('B: smuggled status/stage fields are ignored — state follows `to` only', async () => {
    const dir = mkdtempSync(join(homedir(), 'g1-drag-b-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const { taskId } = await makeTask(port);
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'PLANNING',
        actor: 'human',
        status: 'DONE',
        stage: 'DONE',
      });
      assert.equal(r.status, 200, 'legal transition still succeeds');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(
        view.json['status'],
        'PLANNING',
        'state follows `to`; smuggled status/stage fields are ignored',
      );
    } finally {
      await stopServer(child);
    }
  });

  it('C: the exact Board drag payload succeeds on the same endpoint', async () => {
    const dir = mkdtempSync(join(homedir(), 'g1-drag-c-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const { taskId } = await makeTask(port);
      // This is byte-for-byte what the desktop Board drag sends:
      // Board.tsx:162 → api.transition(taskId, to) → api.ts:606
      // POST /tasks/:id/transition { to, actor: 'human' }.
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'CANCELLED',
        actor: 'human',
      });
      assert.equal(r.status, 200, 'board drag payload must hit the Transition API');
      assert.equal(r.json['to'], 'CANCELLED');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'CANCELLED', 'drag moved the task via the engine');
    } finally {
      await stopServer(child);
    }
  });

  it('D: no read/bypass route exists on /transition', async () => {
    const dir = mkdtempSync(join(homedir(), 'g1-drag-d-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const { taskId } = await makeTask(port);
      const get = await api(port, 'GET', `/api/tasks/${taskId}/transition`);
      assert.equal(get.status, 404, 'GET /transition is not routed');
      const put = await api(port, 'PUT', `/api/tasks/${taskId}/transition`, { to: 'DONE' });
      assert.equal(put.status, 404, 'PUT /transition is not routed');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'TODO', 'state untouched');
    } finally {
      await stopServer(child);
    }
  });

  it('E: an illegal jump is refused with 422, the row is untouched, the denial is audited', async () => {
    const dir = mkdtempSync(join(homedir(), 'g1-drag-e-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const { taskId } = await makeTask(port);
      // TODO has no edge to DONE in the v1 workflow: a drag straight to
      // the DONE column must be refused, not waved through.
      const r = await api(port, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'DONE',
        actor: 'human',
      });
      assert.equal(r.status, 422, 'illegal jump must be 422');
      assert.equal(r.json['reason'], 'UNKNOWN_TRANSITION');
      const view = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(view.json['status'], 'TODO', 'DB row untouched on denial');
      const records = await auditRecords(port);
      const denied = records.find(
        (rec) =>
          rec.action === 'WORKFLOW_TRANSITION_DENIED' &&
          rec.entityId === taskId &&
          (rec.details?.['to'] as string) === 'DONE',
      );
      assert.ok(denied, 'the denial is audited as WORKFLOW_TRANSITION_DENIED');
    } finally {
      await stopServer(child);
    }
  });
});
