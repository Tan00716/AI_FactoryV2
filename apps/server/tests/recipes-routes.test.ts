/**
 * Recipe migration HTTP tests — boots the real server (dist) with an
 * isolated DB + data dir:
 *   GET  /api/recipes                          → 10 builtin recipes
 *   POST /api/recipes/plan                     → 201 plan; 404 unknown recipe; 400 outside roots
 *   POST /api/recipes/runs/:id/request-approval → 201 central approval (action recipes.apply:<id>)
 *   POST /api/recipes/runs/:id/execute         → 403 without approval / with PENDING approval;
 *                                                200 after the approval is APPROVED via /api/approvals
 *   audit log contains RECIPE_PLAN_CREATED / RECIPE_APPROVAL_REQUESTED / RECIPE_APPLIED / RECIPE_VERIFY_PASSED
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/recipes-routes.test.ts
 * (requires a server build first — the server boots from dist).
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
const builtinDir = path.join(here, '..', 'src', 'recipes', 'builtin');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-recipes-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_RECIPE_ROOTS: dir,
    AI_FACTORY_RECIPES_BUILTIN_DIR: builtinDir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, proc, dir };
}

async function api(
  port: number,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

test('recipes HTTP: library, plan, approval gate, execute, audit', async () => {
  const srv = await startServer();
  try {
    // Fixture project inside the allowed roots.
    const proj = path.join(srv.dir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture',
          version: '1.0.0',
          scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // 1. library
    let r = await api(srv.port, 'GET', '/api/recipes');
    assert.equal(r.status, 200);
    const recipes = r.body['recipes'] as Array<{ name: string }>;
    assert.equal(recipes.length, 10);
    assert.ok(recipes.some((x) => x.name === 'react-19-upgrade'));

    // 2. plan errors: unknown recipe → 404; path outside roots → 400.
    r = await api(srv.port, 'POST', '/api/recipes/plan', { recipeName: 'nope', projectPath: proj });
    assert.equal(r.status, 404);
    r = await api(srv.port, 'POST', '/api/recipes/plan', { recipeName: 'react-19-upgrade', projectPath: '/etc' });
    assert.equal(r.status, 400);
    assert.equal(r.body['error'], 'PATH_ESCAPE');

    // 0. grab a real task id (approvals are task-bound by schema).
    r = await api(srv.port, 'GET', '/api/tasks?projectId=proj-myapp');
    assert.equal(r.status, 200);
    const tasks = r.body as unknown as Array<{ id: string }>;
    assert.ok(tasks.length > 0, 'seeded tasks missing');
    const taskId = tasks[0].id;

    // 3. plan OK (nothing written yet).
    r = await api(srv.port, 'POST', '/api/recipes/plan', {
      recipeName: 'react-19-upgrade',
      projectPath: proj,
      taskId,
    });
    assert.equal(r.status, 201);
    const run = r.body['run'] as { id: string; status: string; plan: { applicable: boolean; appliedOps: number } };
    assert.equal(run.status, 'planned');
    assert.equal(run.plan.applicable, true);
    assert.equal(run.plan.appliedOps, 2);
    const runId = run.id;
    assert.ok(fs.readFileSync(path.join(proj, 'package.json'), 'utf8').includes('^18.3.1'));

    // 3b. a run without taskId cannot request approval (TASK_REQUIRED).
    r = await api(srv.port, 'POST', '/api/recipes/plan', { recipeName: 'react-19-upgrade', projectPath: proj });
    assert.equal(r.status, 201);
    const noTaskRun = (r.body['run'] as { id: string }).id;
    r = await api(srv.port, 'POST', `/api/recipes/runs/${noTaskRun}/request-approval`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body['error'], 'TASK_REQUIRED');

    // 4. execute without approval → 403 APPROVAL_REQUIRED.
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/execute`, {});
    assert.equal(r.status, 403);
    assert.equal(r.body['error'], 'APPROVAL_REQUIRED');

    // 5. request approval → central approval with action recipes.apply:<id>.
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/request-approval`, {});
    assert.equal(r.status, 201);
    const approvalId = r.body['approvalId'] as string;
    assert.ok(approvalId);
    r = await api(srv.port, 'GET', `/api/approvals/${approvalId}`);
    assert.equal(r.status, 200);
    const appr = r.body as unknown as { action: string; status: string };
    assert.equal(appr.action, `recipes.apply:${runId}`);
    assert.equal(appr.status, 'PENDING');

    // 6. execute with PENDING approval → 403 APPROVAL_NOT_APPROVED.
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/execute`, { approvalId });
    assert.equal(r.status, 403);
    assert.equal(r.body['error'], 'APPROVAL_NOT_APPROVED');
    assert.ok(fs.readFileSync(path.join(proj, 'package.json'), 'utf8').includes('^18.3.1'));

    // 7. decide approve (decided_by is required by the approvals gate;
    // required_approvers is ['human'] so the decider must be 'human').
    r = await api(srv.port, 'POST', `/api/approvals/${approvalId}/decision`, { approved: true, decided_by: 'human' });
    assert.equal(r.status, 200);

    // 8. execute → done, files rewritten, verify passed.
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/execute`, { approvalId });
    assert.equal(r.status, 200);
    const doneRun = r.body['run'] as { status: string; verifyResults: Array<{ ok: boolean }> };
    assert.equal(doneRun.status, 'done');
    assert.equal(doneRun.verifyResults.length, 2);
    assert.ok(doneRun.verifyResults.every((v) => v.ok));
    const after = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
    assert.equal(after.dependencies.react, '^19.2.0');

    // 9. audit trail.
    r = await api(srv.port, 'GET', '/api/audit?limit=100');
    assert.equal(r.status, 200);
    const actions = (r.body as unknown as Array<{ action: string }>).map((a) => a.action);
    for (const want of [
      'RECIPE_PLAN_CREATED',
      'RECIPE_APPROVAL_REQUESTED',
      'RECIPE_EXECUTION_REJECTED',
      'RECIPE_FILE_APPLIED',
      'RECIPE_APPLIED',
      'RECIPE_VERIFY_PASSED',
      'RECIPE_RUN_DONE',
    ]) {
      assert.ok(actions.includes(want), `audit missing ${want}: ${actions.slice(0, 15)}`);
    }
  } finally {
    srv.proc.kill('SIGKILL');
  }
});
