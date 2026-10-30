/**
 * R7-#8 DB multi-connection + history + ER — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir, then:
 *   drivers        -> catalog lists sqlite/postgres available, mysql unavailable;
 *                     registering mysql -> 400 DRIVER_UNAVAILABLE
 *   meta/active    -> two sqlite connections, active = first, setActive switches
 *   write mode     -> writes refused by default (WRITE_MODE_DISABLED);
 *                     enable without confirm -> 400; with confirm -> 200;
 *                     per-connection (second connection still refused);
 *                     prod can never enable (PROD_WRITE_NEVER)
 *   history        -> refused + successful queries recorded; filter by
 *                     connection; favorite toggle; rerun records a new entry;
 *                     delete; clear
 *   er             -> FK schema yields 2 nodes + 1 edge
 *   secrets        -> a password field in a register body never appears in
 *                     responses or connection metadata
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/dbbrowser-multi.test.ts
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
  const base = path.join(os.homedir(), 'r7w2-8-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

async function startServer(): Promise<Running> {
  const dataDir = homeTmp('aif-dbb8-data-');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    cwd: dataDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start; stderr: ${stderr.slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, proc, dataDir };
}

async function stopServer(s: Running): Promise<void> {
  // Closeout fix: the old sync version rmSync'd the data dir immediately
  // after SIGTERM without waiting for exit, so a still-running server
  // mid-write made rm fail ENOTEMPTY and fail the test. Wait for exit
  // (SIGKILL fallback), then remove with one retry on busy-dir errors.
  s.proc.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => s.proc.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!exited) {
    s.proc.kill('SIGKILL');
    await new Promise((r) => s.proc.once('exit', r));
  }
  try {
    fs.rmSync(s.dataDir, { recursive: true, force: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EBUSY') {
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(s.dataDir, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

test('db multi-connection + history + ER lifecycle', async () => {
  const s = await startServer();
  try {
    // 1. Driver catalog + unavailable-kind refusal.
    const drivers = await api(s, 'GET', '/api/db-browser/drivers');
    assert.equal(drivers.status, 200);
    const list = drivers.body!['drivers'] as Array<Record<string, unknown>>;
    assert.equal(list.find((d) => d['kind'] === 'sqlite')?.['available'], true);
    assert.equal(list.find((d) => d['kind'] === 'postgres')?.['available'], true);
    assert.equal(list.find((d) => d['kind'] === 'mysql')?.['available'], false);
    const badKind = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'my',
      kind: 'mysql',
      host: '127.0.0.1',
    });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body!['code'], 'DRIVER_UNAVAILABLE');

    // 2. Two sqlite connections; a password field is ignored, never echoed.
    const regA = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'shop',
      kind: 'sqlite',
      path: 'shop.db',
      password: 'hunter2-secret',
    });
    assert.equal(regA.status, 201);
    assert.ok(!JSON.stringify(regA.body).includes('hunter2-secret'));
    const regB = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'inv',
      kind: 'sqlite',
      path: 'inv.db',
    });
    assert.equal(regB.status, 201);
    const meta = await api(s, 'GET', '/api/db-browser/connections/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.body!['active'], 'shop');
    assert.equal((meta.body!['connections'] as unknown[]).length, 2);
    assert.ok(!JSON.stringify(meta.body).includes('hunter2-secret'));
    const setActive = await api(s, 'POST', '/api/db-browser/active', { name: 'inv' });
    assert.equal(setActive.status, 200);
    assert.equal(setActive.body!['active'], 'inv');
    const getActive = await api(s, 'GET', '/api/db-browser/active');
    assert.equal(getActive.body!['active'], 'inv');

    // 3. Write mode: refused by default, confirm required, per-connection.
    const refused = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)',
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body!['code'], 'WRITE_MODE_DISABLED');
    const noConfirm = await api(s, 'POST', '/api/db-browser/connections/shop/write-mode', { enabled: true });
    assert.equal(noConfirm.status, 403);
    assert.equal(noConfirm.body!['code'], 'CONFIRM_REQUIRED');
    const wm = await api(s, 'POST', '/api/db-browser/connections/shop/write-mode', {
      enabled: true,
      confirm: true,
    });
    assert.equal(wm.status, 200);
    assert.equal(wm.body!['writeMode'], true);
    const stillRefused = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'inv',
      sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)',
    });
    assert.equal(stillRefused.status, 403);
    assert.equal(stillRefused.body!['code'], 'WRITE_MODE_DISABLED');

    // 4. FK schema on shop, then a read + history checks.
    const create1 = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
    });
    assert.equal(create1.status, 200);
    const create2 = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT)',
    });
    assert.equal(create2.status, 200);
    const ins = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: "INSERT INTO authors (name) VALUES ('octavia')",
    });
    assert.equal(ins.status, 200);
    const sel = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'SELECT name FROM authors',
    });
    assert.equal(sel.status, 200);
    assert.deepEqual((sel.body!['result'] as Record<string, unknown>)['rows'], [{ name: 'octavia' }]);

    const er = await api(s, 'GET', '/api/db-browser/er?connection=shop');
    assert.equal(er.status, 200);
    assert.equal((er.body!['nodes'] as unknown[]).length, 2);
    assert.equal((er.body!['edges'] as unknown[]).length, 1);

    const hist = await api(s, 'GET', '/api/db-browser/history?connection=shop');
    assert.equal(hist.status, 200);
    const entries = hist.body!['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length >= 5, `expected >=5 shop entries, got ${entries.length}`);
    assert.ok(entries.some((e) => e['ok'] === false && e['errorCode'] === 'WRITE_MODE_DISABLED'));
    const readEntry = entries.find((e) => e['sql'] === 'SELECT name FROM authors' && e['ok'] === true);
    assert.ok(readEntry, 'read entry recorded');
    const fav = await api(s, 'POST', `/api/db-browser/history/${readEntry!['id']}/favorite`, { favorite: true });
    assert.equal(fav.status, 200);
    const favOnly = await api(s, 'GET', '/api/db-browser/history?favoritesOnly=1');
    assert.equal((favOnly.body!['entries'] as unknown[]).length, 1);
    const rerun = await api(s, 'POST', `/api/db-browser/history/${readEntry!['id']}/rerun`, {});
    assert.equal(rerun.status, 200);
    assert.deepEqual((rerun.body!['result'] as Record<string, unknown>)['rows'], [{ name: 'octavia' }]);
    assert.ok(rerun.body!['historyId'] && rerun.body!['historyId'] !== readEntry!['id']);
    const afterRerun = await api(s, 'GET', '/api/db-browser/history?connection=shop');
    assert.equal(
      (afterRerun.body!['entries'] as unknown[]).length,
      entries.length + 1,
      'rerun records a new entry',
    );
    const del = await api(s, 'DELETE', `/api/db-browser/history/${readEntry!['id']}`);
    assert.equal(del.status, 200);
    const cleared = await api(s, 'DELETE', '/api/db-browser/history?connection=shop');
    assert.equal(cleared.status, 200);
    assert.ok((cleared.body!['removed'] as number) >= 1);
    const empty = await api(s, 'GET', '/api/db-browser/history?connection=shop');
    assert.equal((empty.body!['entries'] as unknown[]).length, 0);

    // 5. Prod can never enable write mode.
    const seed = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'seed',
      kind: 'sqlite',
      path: 'prod.db',
    });
    assert.equal(seed.status, 201);
    await api(s, 'POST', '/api/db-browser/connections/seed/write-mode', { enabled: true, confirm: true });
    const seedq = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'seed',
      sql: 'CREATE TABLE t (a TEXT)',
    });
    assert.equal(seedq.status, 200);
    const regp = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'proddb',
      kind: 'sqlite',
      path: 'prod.db',
      env: 'prod',
    });
    assert.equal(regp.status, 201);
    const pwm = await api(s, 'POST', '/api/db-browser/connections/proddb/write-mode', {
      enabled: true,
      confirm: true,
    });
    assert.equal(pwm.status, 403);
    assert.equal(pwm.body!['code'], 'PROD_WRITE_NEVER');
  } finally {
    await stopServer(s);
  }
});
