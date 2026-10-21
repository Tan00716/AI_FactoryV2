/**
 * Scope Lock — HTTP integration tests (second-round strengthening,
 * item 8) — boots the real server (dist) with an isolated DB + data
 * dir:
 *   POST /api/tasks {scope}          → scope recorded, returned by task
 *   POST /api/tasks {bad scope}      → 400 INVALID_SCOPE
 *   PATCH /api/tasks/:id {scope}     → updates / null clears
 *   GET  /api/tasks/:id/scope        → report (locked, no shadow yet)
 *   POST /api/file {taskId} in-scope      → 200 written
 *   POST /api/file {taskId} out-of-scope  → 403 SCOPE_LOCKED, NOT written
 *   POST /api/file {taskId} excluded      → 403 reason 'excluded'
 *   POST /api/file no taskId              → 200 (manual editing is
 *                                           unrestricted by design)
 *   POST /api/file {bogus taskId}         → 404 TASK_NOT_FOUND
 *   POST /api/recipes/plan {taskId}       → scope escape → 422
 *   GET  /api/audit                       → SCOPE_VIOLATION entries
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/scope-routes.test.ts
 * (requires `npm run build` first — the server boots from dist.)
 * NOTE: POST /api/file writes are confined to the server's cwd (the
 * repo root under test:server), so this test writes into a uniquely
 * named scratch dir there and removes it in `finally`.
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
const repoRoot = path.join(here, '..', '..', '..');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-scope-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_RECIPE_ROOTS: dir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
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

test('scope lock HTTP: create/PATCH/scope report + file-write gate + recipe gate + audit', async () => {
  const s = await startServer();
  const scratch = `scope-writes-${process.pid}`;
  try {
    const proj = await api(s, 'POST', '/api/projects', { name: 'scope-http-proj' });
    assert.equal(proj.status, 201, `create project: ${JSON.stringify(proj.body).slice(0, 200)}`);
    const projectId = proj.body.id as string;

    // 1. Create a task carrying a scope; the scope is recorded + echoed.
    const created = await api(s, 'POST', '/api/tasks', {
      projectId,
      title: 'scoped task',
      scope: { include: [`${scratch}/**`], exclude: [`${scratch}/secret/**`] },
    });
    assert.equal(created.status, 201);
    const taskId = created.body.id as string;
    assert.deepEqual(created.body.scope, {
      include: [`${scratch}/**`],
      exclude: [`${scratch}/secret/**`],
    });

    // 2. Malformed scope at creation → 400 INVALID_SCOPE (never silent).
    const bad = await api(s, 'POST', '/api/tasks', {
      projectId,
      title: 'bad scope task',
      scope: { include: ['/abs/**'] },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_SCOPE');

    // 3. Report: locked, matches creation; no shadow config yet → the
    //    report is honest (shadow null, no fabricated violations).
    const report = await api(s, 'GET', `/api/tasks/${taskId}/scope`);
    assert.equal(report.status, 200);
    assert.equal(report.body.locked, true);
    assert.deepEqual(report.body.scope.include, [`${scratch}/**`]);
    assert.equal(report.body.shadow, null);
    assert.deepEqual(report.body.outOfScope, []);

    // 4. In-scope attributed write → lands.
    const inScope = await api(s, 'POST', '/api/file', {
      path: `${scratch}/ok/a.txt`,
      content: 'hello',
      actor: 'agent',
      taskId,
    });
    assert.equal(inScope.status, 200, JSON.stringify(inScope.body).slice(0, 200));
    assert.equal(fs.readFileSync(path.join(repoRoot, scratch, 'ok', 'a.txt'), 'utf8'), 'hello');

    // 5. Out-of-scope attributed write → 403 SCOPE_LOCKED + not written.
    const out = await api(s, 'POST', '/api/file', {
      path: `${scratch}-elsewhere/b.txt`,
      content: 'nope',
      actor: 'agent',
      taskId,
    });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'SCOPE_LOCKED');
    assert.equal(out.body.reason, 'not-included');
    assert.equal(fs.existsSync(path.join(repoRoot, `${scratch}-elsewhere`)), false);

    // 6. Excluded attributed write → 403 'excluded'.
    const excl = await api(s, 'POST', '/api/file', {
      path: `${scratch}/secret/k.txt`,
      content: 'key',
      actor: 'agent',
      taskId,
    });
    assert.equal(excl.status, 403);
    assert.equal(excl.body.code, 'SCOPE_LOCKED');
    assert.equal(excl.body.reason, 'excluded');

    // 7. Same path WITHOUT attribution → 200 (manual/unattributed
    //    writes are unrestricted by design).
    const noAttr = await api(s, 'POST', '/api/file', {
      path: `${scratch}/secret/manual.txt`,
      content: 'by hand',
      actor: 'human',
    });
    assert.equal(noAttr.status, 200);

    // 8. Attribution to an unknown task → 404 TASK_NOT_FOUND.
    const bogus = await api(s, 'POST', '/api/file', {
      path: `${scratch}/ok/c.txt`,
      content: 'x',
      actor: 'agent',
      taskId: 'no-such-task',
    });
    assert.equal(bogus.status, 404);
    assert.equal(bogus.body.code, 'TASK_NOT_FOUND');

    // 9. Recipe plan escaping the scope → 422 SCOPE_LOCKED, plan discarded.
    const fixture = path.join(s.dir, 'recipe-proj');
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify(
        { name: 'fixture', version: '1.0.0', dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } },
        null,
        2,
      ) + '\n',
    );
    const plan = await api(s, 'POST', '/api/recipes/plan', {
      recipeName: 'react-19-upgrade',
      projectPath: fixture,
      taskId,
    });
    assert.equal(plan.status, 422, JSON.stringify(plan.body).slice(0, 300));
    assert.equal(plan.body.code, 'SCOPE_LOCKED');
    assert.ok(Array.isArray(plan.body.violations) && plan.body.violations.length > 0);

    // 10. PATCH: clear the scope → the same out-of-scope write now lands.
    const cleared = await api(s, 'PATCH', `/api/tasks/${taskId}`, { scope: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.scope, undefined);
    const after = await api(s, 'POST', '/api/file', {
      path: `${scratch}-elsewhere/b.txt`,
      content: 'now allowed',
      actor: 'agent',
      taskId,
    });
    assert.equal(after.status, 200);

    // 11. PATCH validation.
    const badPatch = await api(s, 'PATCH', `/api/tasks/${taskId}`, { scope: { include: ['../x'] } });
    assert.equal(badPatch.status, 400);
    assert.equal(badPatch.body.code, 'INVALID_SCOPE');
    const noKey = await api(s, 'PATCH', `/api/tasks/${taskId}`, { title: 'nope' });
    assert.equal(noKey.status, 400);

    // 12. Audit: violations + scope updates are on the record.
    const audit = await api(s, 'GET', '/api/audit?limit=300');
    assert.equal(audit.status, 200);
    const rows = audit.body as Array<{ action: string; details?: Record<string, unknown> }>;
    const violations = rows.filter((r) => r.action === 'SCOPE_VIOLATION');
    assert.ok(violations.length >= 2, `expected >=2 SCOPE_VIOLATION rows, got ${violations.length}`);
    assert.ok(violations.some((r) => r.details?.['reason'] === 'excluded'));
    assert.ok(violations.some((r) => r.details?.['surface'] === 'recipes.plan'));
    const updates = rows.filter((r) => r.action === 'TASK_SCOPE_UPDATED');
    assert.ok(updates.length >= 2, 'scope updates (create + PATCH) audited');
  } finally {
    await stopServer(s);
    fs.rmSync(path.join(repoRoot, scratch), { recursive: true, force: true });
    fs.rmSync(path.join(repoRoot, `${scratch}-elsewhere`), { recursive: true, force: true });
  }
});
