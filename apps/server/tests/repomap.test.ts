/**
 * Repo map HTTP tests.
 *
 * Boots the real server (dist) with an isolated DB + data dir and
 * FACTORY_CODEINDEX_ROOTS pointed at a fixture repo:
 *   GET /api/repomap?root= → 200 + ranked map (json)
 *   GET /api/repomap?root=&format=md → markdown rendering
 *   GET /api/repomap with root outside allowlist → 403 ROOT_DENIED
 *   GET /api/repomap with missing root → 400
 *   GET /api/repomap?maxTokens= tiny → truncated map with marker
 *   POST /api/commands/execute {input:'/map'} → 200 type 'map'
 *   GET /api/commands lists the map + map-refresh built-ins
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/repomap.test.ts
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-repomap-'));
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

test('repomap routes: map, markdown, truncation, jail', { timeout: 120_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-rmrepo-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'widget.ts'),
    'export function makeWidget() {}\nexport class Widget {}\n',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'app.ts'),
    "import { makeWidget, Widget } from './widget';\nmakeWidget();\nconst w = new Widget();\nconsole.log(w);\n",
  );

  const s = await startServer(repo);
  try {
    // JSON map: ranked, with signatures and refs.
    const r = await api(s.port, 'GET', `/api/repomap?root=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.format, 'json');
    const map = r.body.map;
    assert.equal(map.version, 1);
    assert.ok(Array.isArray(map.files) && map.files.length === 2);
    // widget.ts defines the referenced symbols → ranked first.
    assert.equal(map.files[0].file, 'src/widget.ts');
    const syms = map.files.flatMap((f: { symbols: Array<{ name: string; refs: number; signature: string }> }) => f.symbols);
    const widget = syms.find((x: { name: string }) => x.name === 'Widget');
    assert.ok(widget, 'Widget symbol present');
    assert.ok(widget.refs >= 1, `Widget refs=${widget.refs}`);
    assert.ok(widget.signature.includes('class Widget'), `signature=${widget.signature}`);
    assert.equal(r.body.stats.symbols, 2, 'makeWidget + Widget');

    // Markdown rendering.
    const md = await api(s.port, 'GET', `/api/repomap?root=${encodeURIComponent(repo)}&format=md`);
    assert.equal(md.status, 200);
    assert.equal(md.body.format, 'md');
    assert.ok((md.body.markdown as string).includes('# Repo map'));
    assert.ok((md.body.markdown as string).includes('## src/widget.ts'));

    // Tiny budget → truncated with an explicit marker.
    const tiny = await api(s.port, 'GET', `/api/repomap?root=${encodeURIComponent(repo)}&format=md&maxTokens=100`);
    assert.equal(tiny.status, 200);
    assert.equal(tiny.body.stats.truncated, true);
    assert.ok((tiny.body.markdown as string).includes('… truncated:'));

    // Path jail: outside the allowlist → 403.
    const denied = await api(s.port, 'GET', `/api/repomap?root=${encodeURIComponent('/tmp')}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'ROOT_DENIED');

    // Missing root → 400.
    const bad = await api(s.port, 'GET', '/api/repomap');
    assert.equal(bad.status, 400);
  } finally {
    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('slash commands /map and /map-refresh execute', { timeout: 120_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-rmrepo-'));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() {}\n');

  const s = await startServer(repo);
  try {
    // Built-ins list includes map + map-refresh.
    const list = await api(s.port, 'GET', '/api/commands');
    assert.equal(list.status, 200);
    const names = (list.body.builtins as { name: string }[]).map((b) => b.name);
    assert.ok(names.includes('map'), `builtins: ${names.join(',')}`);
    assert.ok(names.includes('map-refresh'), `builtins: ${names.join(',')}`);

    // /map with explicit root.
    const m = await api(s.port, 'POST', '/api/commands/execute', { input: `/map ${repo}` });
    assert.equal(m.status, 200);
    assert.equal(m.body.type, 'map');
    assert.ok((m.body.markdown as string).includes('# Repo map'));
    assert.ok((m.body.markdown as string).includes('alpha'));

    // /map with no args falls back to FACTORY_CODEINDEX_ROOTS.
    const d = await api(s.port, 'POST', '/api/commands/execute', { input: '/map' });
    assert.equal(d.status, 200);
    assert.equal(d.body.type, 'map');

    // /map-refresh forces a full rebuild.
    const fr = await api(s.port, 'POST', '/api/commands/execute', { input: `/map-refresh ${repo}` });
    assert.equal(fr.status, 200);
    assert.equal(fr.body.type, 'map');
    assert.equal(fr.body.command, 'map-refresh');
    assert.equal(fr.body.stats.incremental, false);

    // Unknown root → 403, not 500.
    const denied = await api(s.port, 'POST', '/api/commands/execute', { input: '/map /tmp' });
    assert.equal(denied.status, 403);
  } finally {
    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
