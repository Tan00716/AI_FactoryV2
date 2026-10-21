/**
 * Design mode — HTTP integration tests (task ⑨) — boots the real server
 * (dist) with cwd = a temp fixture workspace (files/design routes take
 * WORKSPACE_ROOT from process.cwd()), an isolated DB + data dir:
 *   GET  /api/design/info        → tailwind detected from package.json
 *   POST /api/design/locate      → file + line of the picked element
 *   POST /api/design/apply       → class token written back; a shadow
 *                                  checkpoint id is returned (undo)
 *   POST /api/design/apply bad line → 409 DESIGN_DRIFT
 *   POST /api/design/apply bad token → 400
 *   POST /api/design/locate unknown → found:false
 *
 * Run: npm run build && node scripts/run-tests-tmp.mjs --test apps/server/tests/design-http.test.ts
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

const FIXTURE_HTML = [
  '<!DOCTYPE html>',
  '<html><head><title>Fixture</title></head><body>',
  '<h1 class="text-3xl font-bold">Design fixture</h1>',
  '<button class="btn bg-red-500 text-white p-2">Buy now</button>',
  '</body></html>',
  '',
].join('\n');

async function startServer(): Promise<Running> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-design-ws-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-design-data-'));
  fs.writeFileSync(path.join(root, 'index.html'), FIXTURE_HTML);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', devDependencies: { tailwindcss: '^3.4.0' } }, null, 2),
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 30_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
  return { port, proc, root };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.root, { recursive: true, force: true });
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

const BTN_FP = { tag: 'button', classes: ['btn', 'bg-red-500', 'text-white', 'p-2'], text: 'Buy now' };

test('design mode HTTP lifecycle: info → locate → apply → drift guard', async () => {
  const s = await startServer();
  try {
    const info = await api(s, 'GET', '/api/design/info?path=index.html');
    assert.equal(info.status, 200);
    assert.equal(info.body.exists, true);
    assert.equal(info.body.tailwind, true);

    const loc = await api(s, 'POST', '/api/design/locate', { fingerprint: BTN_FP, path: 'index.html' });
    assert.equal(loc.status, 200);
    assert.equal(loc.body.found, true);
    assert.equal(loc.body.file, 'index.html');
    assert.equal(loc.body.line, 4);
    assert.equal(loc.body.text, 'Buy now');

    const unknown = await api(s, 'POST', '/api/design/locate', {
      fingerprint: { tag: 'section', classes: ['nope'], text: '' },
      path: 'index.html',
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.found, false);

    const applied = await api(s, 'POST', '/api/design/apply', {
      path: 'index.html',
      line: 4,
      fingerprint: BTN_FP,
      edits: { bgColor: 'bg-blue-500', text: 'Add to cart' },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.changed, true);
    assert.ok(typeof applied.body.checkpointId === 'string' && applied.body.checkpointId.length > 0);
    assert.deepEqual([...applied.body.applied].sort(), ['bgColor', 'text']);

    const after = fs.readFileSync(path.join(s.root, 'index.html'), 'utf8');
    assert.ok(after.includes('bg-blue-500'));
    assert.ok(after.includes('>Add to cart</button>'));
    assert.ok(!after.includes('bg-red-500'));

    // Stale line (element edited since) → drift.
    const drift = await api(s, 'POST', '/api/design/apply', {
      path: 'index.html',
      line: 3,
      fingerprint: BTN_FP,
      edits: { bgColor: 'bg-green-500' },
    });
    assert.equal(drift.status, 409);
    assert.equal(drift.body.code, 'DESIGN_DRIFT');

    // Wrong token family → 400 (fontSize token in the bgColor slot).
    const badToken = await api(s, 'POST', '/api/design/apply', {
      path: 'index.html',
      line: 4,
      fingerprint: BTN_FP,
      edits: { bgColor: 'text-xl' },
    });
    assert.equal(badToken.status, 400);

    // Malformed fingerprint → 400.
    const badFp = await api(s, 'POST', '/api/design/locate', {
      fingerprint: { tag: '1bad<>', classes: 'x', text: '' },
    });
    assert.equal(badFp.status, 400);
  } finally {
    await stopServer(s);
  }
});
