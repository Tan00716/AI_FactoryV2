/**
 * R4-A5 DB browser — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir, then:
 *   connections      -> register sqlite in data dir / jail escape -> 403
 *   query console    -> read / write / destructive->approvalRequired / multi-stmt->403
 *   table editor     -> tables, paged/filtered/sorted page, row update (verified)
 *   schema/diff/ddl  -> schema, diff (additive DDL), ddl, er graph
 *   destructive flow -> request -> execute-before-approval 403 ->
 *                       approve via /api/approvals/:id/decision -> execute 200 ->
 *                       execute again 409 (single-use) ; wrong-sql 403
 *   prod env         -> write refused
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/dbbrowser.test.ts
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
  const base = path.join(os.homedir(), 'r4a5-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

async function startServer(): Promise<Running> {
  const dataDir = homeTmp('aif-dbb-data-');
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
  return { port, proc, dataDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
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

test('db-browser HTTP lifecycle', async () => {
  const s = await startServer();
  try {
    // 1. Register a sqlite connection inside the data dir.
    const reg = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'shop',
      kind: 'sqlite',
      path: 'shop.db',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body).slice(0, 300));
    assert.equal(reg.body!['env'], 'dev');

    // 2. Jail: path escaping the data dir -> 403.
    const evil = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'evil',
      kind: 'sqlite',
      path: '../../evil.db',
    });
    assert.equal(evil.status, 403);
    assert.equal((evil.body as Record<string, unknown>)['code'], 'PATH_ESCAPED');

    // 3. Query console: write then read.
    const create = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL)',
    });
    assert.equal(create.status, 200);
    assert.equal(create.body!['verdict'], 'write');
    const ins = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: "INSERT INTO products (name, price) VALUES ('apple', 1.5), ('pear', 2.0)",
    });
    assert.equal(ins.status, 200);
    assert.equal((ins.body!['result'] as Record<string, unknown>)['changes'], 2);
    const sel = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'SELECT name, price FROM products ORDER BY price',
    });
    assert.equal(sel.status, 200);
    assert.equal(sel.body!['verdict'], 'read');
    assert.deepEqual((sel.body!['result'] as Record<string, unknown>)['rows'], [
      { name: 'apple', price: 1.5 },
      { name: 'pear', price: 2.0 },
    ]);

    // 4. Guard: destructive -> approvalRequired; multi-statement -> 403.
    const del = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'DELETE FROM products',
    });
    assert.equal(del.status, 403);
    assert.equal((del.body as Record<string, unknown>)['approvalRequired'], true);
    const multi = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop',
      sql: 'SELECT 1; SELECT 2',
    });
    assert.equal(multi.status, 403);
    assert.equal((multi.body as Record<string, unknown>)['code'], 'MULTIPLE_STATEMENTS');

    // 5. Table editor: tables, page, filter, sort.
    const tables = await api(s, 'GET', '/api/db-browser/tables?connection=shop');
    assert.equal(tables.status, 200);
    assert.deepEqual(tables.body!['tables'], [{ name: 'products', type: 'table' }]);
    const page = await api(s, 'GET', '/api/db-browser/table?connection=shop&name=products&page=2&pageSize=1&orderBy=price&orderDir=desc');
    assert.equal(page.status, 200);
    assert.equal((page.body as Record<string, unknown>)['totalRows'], 2);
    assert.equal(((page.body as Record<string, unknown>)['rows'] as Array<Record<string, unknown>>)[0]!['name'], 'apple');
    const filt = await api(s, 'GET', '/api/db-browser/table?connection=shop&name=products&filter=' + encodeURIComponent(JSON.stringify([{ column: 'price', op: 'gt', value: 1.6 }])));
    assert.equal(filt.status, 200);
    assert.equal((filt.body as Record<string, unknown>)['totalRows'], 1);

    // 6. Row update: write-back is verified by re-read.
    const upd = await api(s, 'PUT', '/api/db-browser/row', {
      connection: 'shop',
      table: 'products',
      pk: { id: 1 },
      patch: { price: 1.75 },
    });
    assert.equal(upd.status, 200);
    assert.equal(((upd.body as Record<string, unknown>)['row'] as Record<string, unknown>)['price'], 1.75);
    assert.equal((upd.body as Record<string, unknown>)['changes'], 1);

    // 7. Schema / DDL / ER.
    const schema = await api(s, 'GET', '/api/db-browser/schema?connection=shop');
    assert.equal(schema.status, 200);
    assert.equal(((schema.body as Record<string, unknown>)['tables'] as unknown[]).length, 1);
    const ddl = await api(s, 'GET', '/api/db-browser/ddl?connection=shop&table=products');
    assert.equal(ddl.status, 200);
    assert.match((ddl.body as Record<string, unknown>)['ddl'] as string, /CREATE TABLE "products"/);
    const er = await api(s, 'GET', '/api/db-browser/er?connection=shop');
    assert.equal(er.status, 200);
    assert.equal(((er.body as Record<string, unknown>)['nodes'] as unknown[]).length, 1);

    // 8. Schema diff: second connection missing a column + table.
    const reg2 = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'shop2',
      kind: 'sqlite',
      path: 'shop2.db',
    });
    assert.equal(reg2.status, 201);
    await api(s, 'POST', '/api/db-browser/query', {
      connection: 'shop2',
      sql: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
    });
    const diff = await api(s, 'POST', '/api/db-browser/schema/diff', { source: 'shop', target: 'shop2' });
    assert.equal(diff.status, 200);
    const ddlLines = (diff.body as Record<string, unknown>)['ddl'] as string[];
    assert.ok(ddlLines.some((d) => /ADD COLUMN "price"/.test(d)), JSON.stringify(ddlLines));
    assert.ok(!ddlLines.some((d) => /DROP/i.test(d)));

    // 9. Destructive approval flow: request -> execute-before-approval 403.
    const req1 = await api(s, 'POST', '/api/db-browser/destructive/request', {
      connection: 'shop',
      sql: 'DROP TABLE products',
    });
    assert.equal(req1.status, 201);
    const ticketId = (req1.body as Record<string, unknown>)['ticketId'] as string;
    assert.ok(ticketId);
    const early = await api(s, 'POST', '/api/db-browser/destructive/execute', {
      ticketId,
      connection: 'shop',
      sql: 'DROP TABLE products',
    });
    assert.equal(early.status, 403);
    assert.equal((early.body as Record<string, unknown>)['code'], 'TICKET_NOT_APPROVED');

    // 10. Non-destructive statement cannot enter the destructive path.
    const notd = await api(s, 'POST', '/api/db-browser/destructive/request', {
      connection: 'shop',
      sql: 'SELECT 1',
    });
    assert.equal(notd.status, 400);
    assert.equal((notd.body as Record<string, unknown>)['code'], 'NOT_DESTRUCTIVE');

    // 11. Approve (decider identity required), then execute; binding mismatch
    // refused; single-use.
    const noDecider = await api(s, 'POST', '/api/db-browser/destructive/approve', { ticketId });
    assert.equal(noDecider.status, 400);
    const appr = await api(s, 'POST', '/api/db-browser/destructive/approve', {
      ticketId,
      decided_by: 'test-human',
    });
    assert.equal(appr.status, 200);
    const wrongSql = await api(s, 'POST', '/api/db-browser/destructive/execute', {
      ticketId,
      connection: 'shop',
      sql: 'DROP TABLE other',
    });
    assert.equal(wrongSql.status, 403);
    assert.equal((wrongSql.body as Record<string, unknown>)['code'], 'TICKET_BINDING_MISMATCH');
    const exec1 = await api(s, 'POST', '/api/db-browser/destructive/execute', {
      ticketId,
      connection: 'shop',
      sql: 'DROP TABLE products',
    });
    assert.equal(exec1.status, 200, JSON.stringify(exec1.body).slice(0, 300));
    const exec2 = await api(s, 'POST', '/api/db-browser/destructive/execute', {
      ticketId,
      connection: 'shop',
      sql: 'DROP TABLE products',
    });
    assert.equal(exec2.status, 409);
    assert.equal((exec2.body as Record<string, unknown>)['code'], 'TICKET_CONSUMED');
    // The drop really happened.
    const after = await api(s, 'GET', '/api/db-browser/tables?connection=shop');
    assert.deepEqual(after.body!['tables'], []);

    // 12. Prod connection: reads ok, writes refused. (The prod file must
    // exist: create it through a dev connection first.)
    const seedp = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'prodseed',
      kind: 'sqlite',
      path: 'prod.db',
    });
    assert.equal(seedp.status, 201);
    const seedq = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'prodseed',
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
    // Prod registration against a missing file is 404 (fail-closed).
    const regpm = await api(s, 'POST', '/api/db-browser/connections', {
      name: 'proddb2',
      kind: 'sqlite',
      path: 'nope.db',
      env: 'prod',
    });
    assert.equal(regpm.status, 404);
    assert.equal((regpm.body as Record<string, unknown>)['code'], 'PROD_DB_NOT_FOUND');
    const pr = await api(s, 'POST', '/api/db-browser/query', { connection: 'proddb', sql: 'SELECT 1 AS one' });
    assert.equal(pr.status, 200);
    const pw = await api(s, 'POST', '/api/db-browser/query', {
      connection: 'proddb',
      sql: 'CREATE TABLE t (a TEXT)',
    });
    assert.equal(pw.status, 403);
    assert.equal((pw.body as Record<string, unknown>)['code'], 'PROD_WRITE_REFUSED');
  } finally {
    await stopServer(s);
  }
});
