/**
 * Walkthrough: product authority defaults to a Human decision (Batch 64, G5 / INV-09).
 *
 * SPEC_V2 INV-09: "生产事故/恢复可按预授权政策自动执行；产品方向默认由
 * Human 决定。" §3.2 Product authority row: "AI 提案，Human 决定" —
 * the project may pre-authorize target categories, but the default for a
 * product-direction proposal is a human decision.
 *
 * What this pins, end to end (real compiled server process, pure HTTP,
 * zero mocks, fresh temp SQLite):
 *
 *   A. A product-direction proposal filed as WAITING_HUMAN_DISPATCH is
 *      recorded waiting — not silently authorized. (The HTTP filing
 *      surface is human-attributed by construction: creator is
 *      hardcoded 'human'; there is no AI filing identity on this path.)
 *   B. The operational pre-authorization escape hatch cannot be used
 *      silently: POST /dispatch with via=POLICY and no policyRuleId is
 *      refused with 400 — a pre-authorization records its triggering
 *      policy and Rule ID (§17.2).
 *   C. A waiting proposal cannot execute: POST /api/runtime/runs on it
 *      is refused with 403 TASK_NOT_AUTHORIZED and zero run records.
 *   D. The loop closes the human way: dispatch via=HUMAN moves the
 *      proposal to AUTHORIZED, and only then is a run accepted (202).
 *
 * Honest boundary: there is no dedicated product-direction decision
 * API — "AI 提案，Human 决定" is realized through the §17.2
 * authorization axis and the dispatch flow. The v1 transition endpoint
 * does not consult the axis (the desktop Board still uses v1; see
 * docs/KNOWN_LIMITATIONS.md) — only the v2 engine treats the axis as a
 * server-side fact. Changing the v1 path is a product decision with
 * Board UX impact, not a test fix.
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

async function bootServer(
  dir: string,
  dbFile: string,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  delete env['FACTORY_GIT_BROKER_ACTIONS'];
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

describe('product authority defaults to a Human decision (G5 / INV-09)', () => {
  it('A–D: a product-direction proposal waits for a human decision; no silent authorization', async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine; see F45).
    const dir = mkdtempSync(join(homedir(), 'g5-product-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const project = await api(port, 'POST', '/api/projects', { name: 'g5-product' });
      assert.equal(project.status, 201);
      const projectId = project.json['id'] as string;

      // A: file the product-direction proposal as awaiting human dispatch.
      const proposal = await api(port, 'POST', '/api/tasks', {
        projectId,
        title: 'Pivot the product to a marketplace model',
        goal: 'Change the product direction',
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
      assert.equal(proposal.status, 201, 'proposal filed');
      assert.equal(
        proposal.json['authorizationStatus'],
        'WAITING_HUMAN_DISPATCH',
        'the proposal is recorded waiting — not silently authorized',
      );
      assert.equal(
        proposal.json['creator'],
        'human',
        'the HTTP filing surface is human-attributed by construction',
      );
      const taskId = proposal.json['id'] as string;

      // B: the operational pre-authorization path cannot silently authorize it.
      const policyDispatch = await api(port, 'POST', `/api/tasks/${taskId}/dispatch`, {
        via: 'POLICY',
      });
      assert.equal(policyDispatch.status, 400, 'POLICY dispatch needs its Rule ID');
      assert.match(
        String(policyDispatch.json['error']),
        /policyRuleId is required when via is POLICY/,
      );
      const stillWaiting = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(
        stillWaiting.json['authorizationStatus'],
        'WAITING_HUMAN_DISPATCH',
        'still waiting after the refused POLICY dispatch',
      );

      // C: the waiting proposal cannot execute.
      const agent = await api(port, 'POST', '/api/agents', {
        name: 'g5-agent',
        jobTitle: 'Engineer',
      });
      assert.equal(agent.status, 201);
      const run = await api(port, 'POST', '/api/runtime/runs', {
        agentId: agent.json['id'],
        taskId,
        script: [{ text: 'pivot the product', toolCalls: [] }],
      });
      assert.equal(run.status, 403, 'a waiting proposal cannot run');
      assert.equal(run.json['code'] ?? run.json['name'], 'TASK_NOT_AUTHORIZED');

      // D: the human decides — dispatch via HUMAN authorizes, and only then
      // does a run get accepted.
      const dispatched = await api(port, 'POST', `/api/tasks/${taskId}/dispatch`, {
        via: 'HUMAN',
        actor: 'human',
      });
      assert.equal(dispatched.status, 200, 'human dispatch succeeds');
      assert.equal(dispatched.json['to'], 'AUTHORIZED');
      const run2 = await api(port, 'POST', '/api/runtime/runs', {
        agentId: agent.json['id'],
        taskId,
        script: [{ text: 'pivot the product', toolCalls: [] }],
      });
      assert.equal(run2.status, 202, 'after the human decision, a run is accepted');
    } finally {
      await stopServer(child);
    }
  });
});
