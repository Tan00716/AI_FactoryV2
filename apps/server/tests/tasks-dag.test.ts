/**
 * Task dependency DAG HTTP tests (R7-#4) — boots the real server (dist)
 * with an isolated DB and exercises the DAG additions end to end:
 *
 *   PUT /api/tasks (cyclic)       400 cycle-detected, writes nothing
 *   GET /api/tasks/graph          diamond nodes + levels + edges, plus
 *                                 last-run status overlay after a run
 *   POST /api/tasks/run (diamond) all four tasks run, base exactly once
 *   POST /api/tasks/run (fail)    failed dep -> dependent recorded as
 *                                 'skipped' with the dep named; the
 *                                 dependent-of-skipped also skipped with
 *                                 the ROOT failed dep named
 *   POST /api/tasks/run (linear)  no-dependsOn chain behaves as before
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/tasks-dag.test.ts
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

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  projDir: string;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-dag-http-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(path.join(projDir, '.ai-factory'), { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // NOTE: the DB dir must NOT contain the project root: the control-dir
    // guard refuses any task cwd under dirname(DB_PATH) (substring match).
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_SHADOW_ROOTS: dir,
    // Test-harness opt-in: the server is fail-closed without a token
    // even on loopback since V3-#1.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    // R17 #6(k): task runs are fail-closed without bwrap; this test
    // exercises the DAG itself, so it opts out explicitly.
    FACTORY_EXEC_SANDBOX: '0',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY']) {
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
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, proc, dir, projDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function writeTasks(projDir: string, tasks: unknown): void {
  fs.writeFileSync(
    path.join(projDir, '.ai-factory', 'tasks.json'),
    JSON.stringify({ version: '2.0.0', tasks }),
    'utf8',
  );
}

test('task DAG end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    // 1. Save-time cycle rejection: the cyclic PUT fails and the
    // previously saved file is untouched.
    writeTasks(srv.projDir, [
      { label: 'base', type: 'shell', command: 'echo base' },
    ]);
    const cyclic = await api(srv.port, 'PUT', '/api/tasks', {
      root: srv.projDir,
      text: JSON.stringify({ tasks: [
        { label: 'x', command: 'echo x', dependsOn: ['y'] },
        { label: 'y', command: 'echo y', dependsOn: ['x'] },
      ] }),
    });
    assert.equal(cyclic.status, 400, JSON.stringify(cyclic.body));
    assert.equal(cyclic.body.code, 'cycle-detected');
    assert.match(cyclic.body.error, /x -> y -> x/);
    const listed = await api(srv.port, 'GET', `/api/tasks/list?root=${encodeURIComponent(srv.projDir)}`);
    assert.equal(listed.body.tasks.length, 1);
    assert.equal(listed.body.tasks[0].label, 'base');

    // 2. Diamond graph: levels 0/1/1/2, four edges, no status yet.
    writeTasks(srv.projDir, [
      { label: 'top', type: 'shell', command: 'echo top', dependsOn: ['left', 'right'], dependsOrder: 'parallel' },
      { label: 'left', type: 'shell', command: 'echo left', dependsOn: ['base'] },
      { label: 'right', type: 'shell', command: 'echo right', dependsOn: ['base'] },
      { label: 'base', type: 'shell', command: 'echo base' },
    ]);
    const graph = await api(srv.port, 'GET', `/api/tasks/graph?label=top&root=${encodeURIComponent(srv.projDir)}`);
    assert.equal(graph.status, 200, JSON.stringify(graph.body));
    const level = new Map(graph.body.nodes.map((n: any) => [n.label, n.level]));
    assert.equal(level.get('base'), 0);
    assert.equal(level.get('left'), 1);
    assert.equal(level.get('right'), 1);
    assert.equal(level.get('top'), 2);
    assert.deepEqual(
      graph.body.edges.map((e: any) => `${e.from}->${e.to}`).sort(),
      ['base->left', 'base->right', 'left->top', 'right->top'].sort(),
    );
    assert.equal(graph.body.nodes.find((n: any) => n.label === 'top').parallel, true);
    assert.ok(graph.body.nodes.every((n: any) => n.status === null));
    assert.equal(graph.body.lastRunId, null);

    // 3. Diamond run: all four run, base exactly once, chain ok.
    const run = await api(srv.port, 'POST', '/api/tasks/run', {
      label: 'top', root: srv.projDir, projectId: 'dag-proj',
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.ok, true);
    assert.equal(run.body.results.filter((r: any) => r.label === 'base').length, 1);
    assert.equal(run.body.results.length, 4);
    assert.ok(run.body.results.every((r: any) => r.status === 'ok'));

    // 4. Graph status overlay now reflects the last run.
    const graph2 = await api(srv.port, 'GET', `/api/tasks/graph?label=top&root=${encodeURIComponent(srv.projDir)}`);
    assert.equal(graph2.status, 200);
    assert.ok(graph2.body.nodes.every((n: any) => n.status === 'ok'));
    assert.ok(typeof graph2.body.lastRunId === 'string');

    // 5. Failure propagation: boom fails -> mid skipped naming boom ->
    // top2 skipped naming the ROOT failed dep (boom), not mid.
    writeTasks(srv.projDir, [
      { label: 'top2', type: 'shell', command: 'echo never', dependsOn: ['mid'] },
      { label: 'mid', type: 'shell', command: 'echo never', dependsOn: ['boom'] },
      { label: 'boom', type: 'process', command: 'node', args: ['--no-such-flag-xyz'] },
    ]);
    const fail = await api(srv.port, 'POST', '/api/tasks/run', {
      label: 'top2', root: srv.projDir, projectId: 'dag-proj',
    });
    assert.equal(fail.status, 200, JSON.stringify(fail.body));
    assert.equal(fail.body.ok, false);
    assert.equal(fail.body.stoppedAt, 'top2');
    assert.deepEqual(
      fail.body.results.map((r: any) => `${r.label}:${r.status}`),
      ['boom:failed', 'mid:skipped', 'top2:skipped'],
    );
    assert.match(fail.body.results[1].error, /"boom"/);
    assert.match(fail.body.results[2].error, /"boom"/);

    // 6. Linear chain (no dependsOn) behaves exactly as before.
    writeTasks(srv.projDir, [
      { label: 'solo', type: 'shell', command: 'echo solo' },
    ]);
    const solo = await api(srv.port, 'POST', '/api/tasks/run', {
      label: 'solo', root: srv.projDir, projectId: 'dag-proj',
    });
    assert.equal(solo.status, 200, JSON.stringify(solo.body));
    assert.equal(solo.body.ok, true);
    assert.deepEqual(solo.body.results.map((r: any) => r.label), ['solo']);

    // 7. Graph errors: unknown label, missing file.
    const unknown = await api(srv.port, 'GET', `/api/tasks/graph?label=nope&root=${encodeURIComponent(srv.projDir)}`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'plan-failed');
    const noLabel = await api(srv.port, 'GET', `/api/tasks/graph?root=${encodeURIComponent(srv.projDir)}`);
    assert.equal(noLabel.status, 400);
    assert.equal(noLabel.body.code, 'bad-label');
  } finally {
    await stopServer(srv);
  }
});
