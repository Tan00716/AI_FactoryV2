/**
 * Notebook HTTP tests (round-7 task R7-#2) — boots the real server
 * (dist) with an isolated DB and exercises the whole feature:
 *
 *   POST /api/notebooks, add code + markdown cells, run one cell,
 *   markdown run -> 400, run-all in order with failure continuation,
 *   move, clear-outputs, export with/without stripOutputs, delete.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/notebooks.test.ts
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-notebook-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    // Test-harness opt-in: the server is fail-closed without a token
    // even on loopback since V3-#1, so notebook HTTP tests boot with
    // explicit open-local mode.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
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
  return { port, proc, dir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
  fs.rmSync(r.dir, { recursive: true, force: true });
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

test('notebook lifecycle over HTTP', async () => {
  const srv = await startServer();
  try {
    // 1. Create + list.
    let r = await api(srv.port, 'POST', '/api/notebooks', { name: 'demo', language: 'typescript' });
    assert.equal(r.status, 201);
    const id = r.body.notebook.id as string;
    assert.ok(id);
    r = await api(srv.port, 'GET', '/api/notebooks');
    assert.equal(r.status, 200);
    assert.equal(r.body.notebooks.length, 1);
    assert.ok(r.body.languages.some((l: { id: string }) => l.id === 'typescript'));

    // 2. Add a code cell and run it.
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells`, {
      kind: 'code',
      language: 'typescript',
      source: 'console.log("hello notebook");',
    });
    assert.equal(r.status, 201);
    const codeCell = r.body.cellId as string;
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells/${codeCell}/run`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.run.ok, true);
    assert.equal(r.body.run.exitCode, 0);
    assert.match(r.body.run.stdout, /hello notebook/);
    assert.equal(r.body.notebook.cells[0].run.ok, true);

    // 3. Markdown cell: add, render source back, run -> 400.
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells`, {
      kind: 'markdown',
      source: '# Notes\nSome text.',
    });
    assert.equal(r.status, 201);
    const mdCell = r.body.cellId as string;
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells/${mdCell}/run`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'not-code');

    // 4. Failing cell + run-all: failure does not stop later cells.
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells`, {
      kind: 'code',
      language: 'javascript',
      source: 'process.exit(9);',
    });
    assert.equal(r.status, 201);
    const failCell = r.body.cellId as string;
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells`, {
      kind: 'code',
      language: 'javascript',
      source: 'console.log("after failure");',
    });
    assert.equal(r.status, 201);
    const afterCell = r.body.cellId as string;
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/run-all`, {});
    assert.equal(r.status, 200);
    const byId = new Map(r.body.results.map((x: { cellId: string }) => [x.cellId, x]));
    assert.equal((byId.get(mdCell) as { skipped: boolean }).skipped, true);
    assert.equal((byId.get(failCell) as { ok: boolean }).ok, false);
    assert.equal((byId.get(failCell) as { exitCode: number }).exitCode, 9);
    assert.equal((byId.get(afterCell) as { ok: boolean }).ok, true);
    const afterNb = r.body.notebook.cells.find((c: { id: string }) => c.id === afterCell);
    assert.match(afterNb.outputs[0].text, /after failure/);

    // 5. Move + update source + clear outputs.
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells/${afterCell}/move`, { direction: 'up' });
    assert.equal(r.status, 200);
    r = await api(srv.port, 'PUT', `/api/notebooks/${id}/cells/${afterCell}`, { source: 'console.log("moved");' });
    assert.equal(r.status, 200);
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/clear-outputs`, {});
    assert.equal(r.status, 200);
    assert.ok(r.body.notebook.cells.every((c: { outputs: unknown[] }) => c.outputs.length === 0));

    // 6. Export: with outputs, then stripped.
    r = await api(srv.port, 'POST', `/api/notebooks/${id}/cells/${codeCell}/run`, {});
    assert.equal(r.status, 200);
    r = await api(srv.port, 'GET', `/api/notebooks/${id}/export`);
    assert.equal(r.status, 200);
    assert.equal(r.body.stripped, false);
    assert.ok(r.body.notebook.cells[0].outputs.length > 0);
    r = await api(srv.port, 'GET', `/api/notebooks/${id}/export?stripOutputs=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.stripped, true);
    assert.ok(r.body.notebook.cells.every((c: { outputs: unknown[] }) => c.outputs.length === 0));

    // 7. Unknown notebook / cell fail closed; delete removes.
    r = await api(srv.port, 'GET', '/api/notebooks/11111111-1111-1111-1111-111111111111');
    assert.equal(r.status, 404);
    r = await api(srv.port, 'PUT', `/api/notebooks/${id}/cells/cell-999`, { source: 'x' });
    assert.equal(r.status, 404);
    r = await api(srv.port, 'DELETE', `/api/notebooks/${id}`);
    assert.equal(r.status, 200);
    r = await api(srv.port, 'GET', '/api/notebooks');
    assert.equal(r.body.notebooks.length, 0);
  } finally {
    await stopServer(srv);
  }
});
