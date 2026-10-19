/**
 * Code index HTTP tests.
 *
 * Boots the real server (dist) with an isolated DB + data dir and
 * FACTORY_CODEINDEX_ROOTS pointed at a fixture repo:
 *   POST /api/codeindex/index {root} → 200 + stats
 *   GET /api/codeindex/search?root=&q= → hits with file+line
 *   GET /api/codeindex/definition?root=&name= → exact symbol
 *   POST index with root outside allowlist → 403 ROOT_DENIED
 *   GET search with no index built → 409 NOT_INDEXED
 *   POST index with missing root → 400
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/codeindex.test.ts
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

async function startServer(repoRoot: string): Promise<{ port: number; proc: ChildProcess; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-codeindex-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: repoRoot,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir };
}

async function api(port: number, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('codeindex routes: index, search, definition, jail', { timeout: 120_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-cirepo-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'widget.ts'), 'export function makeWidget() {}\nexport class Widget {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'main.py'), 'def run_server():\n    pass\n');

  const s = await startServer(repo);
  try {
    // Search before indexing -> 409 NOT_INDEXED.
    const pre = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(repo)}&q=widget`);
    assert.equal(pre.status, 409);
    assert.equal(pre.body.error, 'NOT_INDEXED');

    // Build the index.
    const built = await api(s.port, 'POST', '/api/codeindex/index', { root: repo });
    assert.equal(built.status, 200);
    assert.ok(built.body.stats.files >= 2, JSON.stringify(built.body.stats));
    assert.ok(built.body.stats.symbols >= 3);

    // Symbol search.
    const search = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(repo)}&q=widget`);
    assert.equal(search.status, 200);
    const hits = search.body.hits as Array<{ symbol?: string; file: string; line: number }>;
    assert.ok(hits.some((h) => h.symbol === 'makeWidget' && h.file === 'src/widget.ts' && h.line === 1));

    // Text search.
    const text = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(repo)}&q=run_server&mode=text`);
    assert.equal(text.status, 200);
    assert.ok((text.body.hits as unknown[]).length > 0);

    // Definition lookup.
    const def = await api(s.port, 'GET', `/api/codeindex/definition?root=${encodeURIComponent(repo)}&name=Widget`);
    assert.equal(def.status, 200);
    assert.equal((def.body.hits as Array<{ kind: string }>).length, 1);
    assert.equal((def.body.hits as Array<{ kind: string }>)[0].kind, 'class');

    // Path jail: outside the allowlist -> 403.
    const denied = await api(s.port, 'POST', '/api/codeindex/index', { root: '/tmp' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'ROOT_DENIED');

    // Missing root -> 400.
    const bad = await api(s.port, 'POST', '/api/codeindex/index', {});
    assert.equal(bad.status, 400);
  } finally {
    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
