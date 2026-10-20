/**
 * Inspection HTTP tests — boots the real server (dist) with an isolated
 * DB + data dir + inspection roots:
 *   GET  /api/inspections           → 400 without projectId; profile + baseline state
 *   PUT  /api/inspections/profile   → 400 on invalid profile; persists valid
 *   POST /api/inspections/run       → first run establishes baseline; later runs report new only
 *   POST /api/inspections/baseline  → explicit re-baseline zeroes new findings
 *   GET  /api/inspections/history   → run entries accumulate
 *   root jail                       → /etc refused with 403
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/inspections-routes.test.ts
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
  root: string;
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

function fixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.ts'), "// TODO: alpha\nconst x = 1;\n", 'utf8');
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-inspect-http-'));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root, { recursive: true });
  fixture(root);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_INSPECT_ROOTS: root,
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
  return { port, proc, dir, root };
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

test('GET /api/inspections: 400 without projectId; defaults when unconfigured', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'GET', '/api/inspections');
    assert.equal(bad.status, 400);
    const r = await api(s.port, 'GET', `/api/inspections?projectId=proj-a&root=${encodeURIComponent(s.root)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.profileSource, 'default-missing');
    assert.equal(r.body.baseline.exists, false);
    assert.equal(r.body.lastRun, null);
  } finally {
    await stopServer(s);
  }
});

test('PUT /api/inspections/profile: 400 on invalid input; persists valid profile', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'PUT', '/api/inspections/profile', {
      projectId: 'proj-b',
      root: s.root,
      profile: { checkers: { nope: true } },
    });
    assert.equal(bad.status, 400);
    const ok = await api(s.port, 'PUT', '/api/inspections/profile', {
      projectId: 'proj-b',
      root: s.root,
      profile: { name: 'team', maxFileLines: 500, checkers: { 'console-log': false } },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile.name, 'team');
    assert.equal(ok.body.profile.maxFileLines, 500);
    const get = await api(s.port, 'GET', `/api/inspections?projectId=proj-b&root=${encodeURIComponent(s.root)}`);
    assert.equal(get.body.profileSource, 'file');
    assert.equal(get.body.profile.name, 'team');
  } finally {
    await stopServer(s);
  }
});

test('POST /api/inspections/run: first run baselines; second run clean; new file flagged', async () => {
  const s = await startServer();
  try {
    const r1 = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-c', root: s.root });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.baselineEstablished, true);
    assert.equal(r1.body.newCount, 0);
    assert.equal(r1.body.totals.total, 1);
    const r2 = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-c', root: s.root });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.baselineEstablished, false);
    assert.equal(r2.body.newCount, 0);
    fs.writeFileSync(path.join(s.root, 'src', 'b.ts'), '// FIXME: beta\n', 'utf8');
    const r3 = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-c', root: s.root });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.newCount, 1);
    assert.match(r3.body.newFindings[0].message, /FIXME/);
  } finally {
    await stopServer(s);
  }
});

test('POST /api/inspections/baseline: explicit re-baseline zeroes new findings', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-d', root: s.root });
    fs.writeFileSync(path.join(s.root, 'src', 'c.ts'), 'console.log("left");\n', 'utf8');
    const before = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-d', root: s.root });
    assert.ok(before.body.newCount >= 1);
    const bl = await api(s.port, 'POST', '/api/inspections/baseline', { projectId: 'proj-d', root: s.root });
    assert.equal(bl.status, 200);
    assert.equal(bl.body.baseline.exists, true);
    const after = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-d', root: s.root });
    assert.equal(after.body.newCount, 0);
  } finally {
    await stopServer(s);
  }
});

test('GET /api/inspections/history: entries accumulate per project', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-e', root: s.root });
    await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-e', root: s.root });
    const h = await api(s.port, 'GET', '/api/inspections/history?projectId=proj-e');
    assert.equal(h.status, 200);
    assert.equal(h.body.runs.length, 2);
    assert.equal(h.body.runs[0].baselineEstablished, true);
    assert.equal(h.body.runs[1].baselineEstablished, false);
    const other = await api(s.port, 'GET', '/api/inspections/history?projectId=proj-other');
    assert.equal(other.body.runs.length, 0);
  } finally {
    await stopServer(s);
  }
});

test('root jail: /etc is refused with 403', async () => {
  const s = await startServer();
  try {
    const r = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-f', root: '/etc' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'INSPECTION_ROOT_DENIED');
    const g = await api(s.port, 'GET', '/api/inspections?projectId=proj-f&root=%2Fetc');
    assert.equal(g.status, 403);
  } finally {
    await stopServer(s);
  }
});

test('run response includes the heuristic license audit note', async () => {
  const s = await startServer();
  try {
    const r = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'proj-g', root: s.root });
    assert.equal(r.status, 200);
    assert.equal(r.body.licenses.scanned, true);
    assert.equal(r.body.licenses.nodeModulesPresent, false);
    assert.match(r.body.licenses.note, /heuristics/);
  } finally {
    await stopServer(s);
  }
});
