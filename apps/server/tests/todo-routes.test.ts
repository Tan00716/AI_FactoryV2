/**
 * R4-B9 TODO tracker — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir and
 * FACTORY_INSPECT_ROOTS pointed at a fixture repo, then:
 *   GET  /api/todos            → defaults (4 patterns) + exact item set;
 *                                indexing-ignore'd dir excluded via ignore gate
 *   GET  /api/todos/file       → single-file items (gutter path)
 *   GET  /api/todos/file?path=../x → 403 (jail)
 *   PUT  /api/todos            → custom patterns stored + applied
 *   PUT  /api/todos            → bad regexp → 400 naming the pattern
 *   POST /api/todos/reset      → defaults restored
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/todo-routes.test.ts
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
  dataDir: string;
  repoDir: string;
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

/** Home-based temp root (the /tmp hygiene rule: /tmp is a 512MB tmpfs). */
function homeTmp(prefix: string): string {
  const base = path.join(os.homedir(), 'r4b9-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function makeRepo(): string {
  const dir = homeTmp('aif-todo-repo-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ignored-dir'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ai-factory'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'main.ts'),
    ['// TODO: wire up', '// FIXME: none yet', '// NOTE: custom works', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'docs', 'notes.md'),
    ['# Notes', '<!-- TODO: write more -->', ''].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'ignored-dir', 'x.ts'), '// TODO: invisible\n');
  // Two-tier ignore gate (task 2): the indexing layer prunes this dir.
  fs.writeFileSync(path.join(dir, '.ai-factory', 'indexing-ignore'), 'ignored-dir/\n');
  return dir;
}

async function startServer(): Promise<Running> {
  const dataDir = homeTmp('aif-todo-data-');
  const repoDir = makeRepo();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
    FACTORY_INSPECT_ROOTS: repoDir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 45_000;
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
    await new Promise((r) => setTimeout(r, 150));
  }
  if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
  return { port, proc, dataDir, repoDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  fs.rmSync(s.repoDir, { recursive: true, force: true });
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

test('todo HTTP lifecycle: scan → file → jail → custom → invalid → reset', async () => {
  const s = await startServer();
  try {
    // 1. Full scan: defaults + exact item set; .gitignore'd dir excluded.
    const scan = await api(s, 'GET', '/api/todos');
    assert.equal(scan.status, 200, JSON.stringify(scan.body).slice(0, 300));
    assert.equal(scan.body.patterns.length, 4);
    assert.ok(scan.body.patterns.every((p: { builtin: boolean }) => p.builtin));
    const simple = (scan.body.items as Array<Record<string, unknown>>).map((i) => [
      i['file'],
      i['line'],
      i['tag'],
      i['severity'],
    ]);
    assert.deepEqual(simple, [
      ['docs/notes.md', 2, 'TODO', 'info'],
      ['src/main.ts', 1, 'TODO', 'info'],
      ['src/main.ts', 2, 'FIXME', 'error'],
    ]);
    assert.ok(scan.body.stats.filesScanned >= 3);
    assert.equal(scan.body.stats.truncated, false);

    // 2. Single file (gutter path).
    const file = await api(s, 'GET', '/api/todos/file?path=src/main.ts');
    assert.equal(file.status, 200);
    assert.equal(file.body.items.length, 2);
    assert.ok((file.body.items as Array<Record<string, unknown>>).every((i) => i['file'] === 'src/main.ts'));

    // 3. Path jail: escape attempt → 403.
    const evil = await api(s, 'GET', '/api/todos/file?path=../outside.ts');
    assert.equal(evil.status, 403);

    // 4. Custom patterns: NOTE only.
    const put = await api(s, 'PUT', '/api/todos', {
      patterns: [{ name: 'NOTE', regexp: '\\bNOTE\\b\\s*:?\\s*(.*)$', severity: 'warning' }],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));
    assert.equal(put.body.patterns.length, 1);
    assert.equal(put.body.patterns[0].builtin, false);
    const scan2 = await api(s, 'GET', '/api/todos');
    const tags2 = (scan2.body.items as Array<Record<string, unknown>>).map((i) => i['tag']);
    assert.deepEqual(tags2, ['NOTE']);

    // 5. Invalid regexp → 400 naming the pattern; config unchanged.
    const bad = await api(s, 'PUT', '/api/todos', {
      patterns: [{ name: 'BROKEN', regexp: '([', severity: 'info' }],
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /BROKEN/);
    const scan3 = await api(s, 'GET', '/api/todos');
    assert.equal(scan3.body.patterns.length, 1);
    assert.equal(scan3.body.patterns[0].name, 'NOTE');

    // 6. Reset → defaults restored.
    const reset = await api(s, 'POST', '/api/todos/reset', {});
    assert.equal(reset.status, 200);
    assert.equal(reset.body.patterns.length, 4);
    const scan4 = await api(s, 'GET', '/api/todos');
    assert.equal(scan4.body.items.length, 3);
  } finally {
    await stopServer(s);
  }
});
