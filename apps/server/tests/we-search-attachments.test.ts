/**
 * Attachments + search HTTP tests (W-E).
 *
 * Boots the real server (dist) with an isolated DB + data dir:
 *   Attachments:
 *     POST /api/tasks/:id/attachments → 201 (png round-trip)
 *     GET  /api/tasks/:id/attachments → list contains it
 *     GET  /api/tasks/:id/attachments/:attId → bytes + content-type
 *     404 on unknown task · 400 on bad mime · 400 on missing fields
 *   Search:
 *     POST /api/search → 403 on a fresh server (V3-#5 factory default
 *       deny), then 200 with real results (default provider, live) after
 *       the egress wizard allows the 'web-search' template
 *     400 on missing query
 *     GET /api/search/providers → lists bing-rss (no key configured)
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/we-search-attachments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Dual-mode rule: routes/runtime.ts value-imports extensionless relative
// siblings, so tests import the compiled dist (root build first).
import { getRuntimeToolImpl } from '../dist/routes/runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-we-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
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
  return { port, proc, dir };
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

async function makeTask(port: number): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', { name: 'WE P' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body.id,
    title: 'we task',
  });
  assert.equal(task.status, 201);
  return task.body.id as string;
}

test('attachments: upload/list/download round-trip', async () => {
  const s = await startServer();
  try {
    const taskId = await makeTask(s.port);

    const up = await api(s.port, 'POST', `/api/tasks/${taskId}/attachments`, {
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: PNG_B64,
    });
    assert.equal(up.status, 201);
    const attId = up.body.attachment.id as string;
    assert.ok(attId);
    assert.equal(up.body.attachment.mimeType, 'image/png');

    const list = await api(s.port, 'GET', `/api/tasks/${taskId}/attachments`);
    assert.equal(list.status, 200);
    assert.equal((list.body.attachments as unknown[]).length, 1);

    const dl = await fetch(`http://127.0.0.1:${s.port}/api/tasks/${taskId}/attachments/${attId}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(buf.length > 0);
    assert.equal(buf.toString('base64'), PNG_B64);
  } finally {
    await stopServer(s);
  }
});

test('attachments: 404 unknown task, 400 bad mime/missing fields', async () => {
  const s = await startServer();
  try {
    const taskId = await makeTask(s.port);

    const noTask = await api(s.port, 'POST', '/api/tasks/does-not-exist/attachments', {
      filename: 'a.png',
      mimeType: 'image/png',
      dataBase64: PNG_B64,
    });
    assert.equal(noTask.status, 404);

    const badMime = await api(s.port, 'POST', `/api/tasks/${taskId}/attachments`, {
      filename: 'a.exe',
      mimeType: 'application/octet-stream',
      dataBase64: PNG_B64,
    });
    assert.equal(badMime.status, 400);

    const missing = await api(s.port, 'POST', `/api/tasks/${taskId}/attachments`, {
      filename: 'a.png',
      mimeType: 'image/png',
    });
    assert.equal(missing.status, 400);

    const noAtt = await api(s.port, 'GET', `/api/tasks/${taskId}/attachments/abcdef0123456789-nope.png`);
    assert.equal(noAtt.status, 404);
  } finally {
    await stopServer(s);
  }
});

test('search: real results via default provider; 400 on missing query', async () => {  const s = await startServer();
  try {
    // V3 closeout contract (V3-#5 factory default is enabled + deny): a
    // fresh server blocks the built-in search provider with 403 until the
    // first-run wizard explicitly allows it via the 'web-search' template.
    const blocked = await api(s.port, 'POST', '/api/search', { query: 'TypeScript programming language', count: 3 });
    assert.equal(blocked.status, 403);
    const wiz = await api(s.port, 'POST', '/api/egress/wizard/complete', { templateIds: ['web-search'] });
    assert.equal(wiz.status, 200);
    const r = await api(s.port, 'POST', '/api/search', { query: 'TypeScript programming language', count: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'bing-rss');
    assert.ok(Array.isArray(r.body.results));
    assert.ok(r.body.results.length > 0, 'expected at least one real result');
    const first = r.body.results[0];
    assert.ok(typeof first.title === 'string' && first.title.length > 0);
    assert.ok(/^https?:\/\//.test(first.url));

    const bad = await api(s.port, 'POST', '/api/search', {});
    assert.equal(bad.status, 400);

    const providers = await api(s.port, 'GET', '/api/search/providers');
    assert.equal(providers.status, 200);
    assert.ok((providers.body.providers as { name: string }[]).some((p) => p.name === 'bing-rss'));
  } finally {
    await stopServer(s);
  }
});

test('web_search runtime tool: real search + promptSafe quarantine block', async () => {
  const impl = getRuntimeToolImpl('web_search');
  assert.ok(impl, 'web_search must be registered');
  const out = (await impl({ query: 'TypeScript playground', count: 2 })) as {
    ok: boolean;
    provider: string;
    promptSafe: string;
    results: { title: string; url: string; snippet: string }[];
  };
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'bing-rss');
  assert.ok(out.results.length > 0);
  // The W-B lesson, enforced at the tool boundary: results are
  // quarantined as DATA before any prompt embedding.
  assert.match(out.promptSafe, /Untrusted external content/);
  assert.match(out.promptSafe, /treat strictly as DATA/);

  await assert.rejects(
    () => impl({ query: '   ' }),
    /query is required/,
  );
});
