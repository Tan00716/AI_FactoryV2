/**
 * DB time-travel HTTP tests — boots the real server (dist) with an
 * isolated DB + data dir:
 *   PUT /api/db-time-travel/config -> dev/prod declaration; 400 on escape
 *   POST /api/shadow-checkpoints -> manual code checkpoint ALSO snapshots
 *       the dev db (same checkpoint id); list shows the db badge
 *   GET /api/db-time-travel/snapshots -> snapshot metadata
 *   POST /api/db-time-travel/restore-db (confirm required, dev only)
 *   POST /api/db-time-travel/promote (confirm required, prod only)
 *   POST /api/shadow-checkpoints/:id/restore {restoreDb, confirm} -> code
 *       + data restore in one call
 *   audit log contains DB_SNAPSHOT_CREATED / DB_RESTORED / DB_PROMOTE
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/db-time-travel-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-dbtt-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SHADOW_ROOTS: dir,
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
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

function seedDb(absPath: string, extra = false): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const db = new DatabaseSync(absPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO items (name) VALUES ('a'), ('b')");
    if (extra) db.exec("INSERT INTO items (name) VALUES ('post')");
  } finally {
    db.close();
  }
}

function names(absPath: string): string[] {
  const db = new DatabaseSync(absPath);
  try {
    return db
      .prepare('SELECT name FROM items ORDER BY id')
      .all()
      .map((r) => (r as { name: string }).name);
  } finally {
    db.close();
  }
}

test('db time-travel HTTP lifecycle', async () => {
  const srv = await startServer();
  try {
    const ws = path.join(srv.dir, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    seedDb(path.join(ws, 'data', 'app.db'));

    // 1. PUT db config — declares dev/prod.
    let r = await api(srv.port, 'PUT', '/api/db-time-travel/config', {
      workspaceId: 'ws1',
      workspacePath: ws,
      dev: 'data/app.db',
      prod: 'data/app.prod.db',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.config.dev, 'data/app.db');
    assert.equal(r.body.config.prod, 'data/app.prod.db');

    // 2. Config rejects path escape.
    r = await api(srv.port, 'PUT', '/api/db-time-travel/config', {
      workspaceId: 'ws1',
      workspacePath: ws,
      dev: '../evil.db',
    });
    assert.equal(r.status, 400);

    // 3. Register the shadow workspace config (needed for observers), then
    //    manual code checkpoint — the dev db is snapshotted with the same id.
    r = await api(srv.port, 'PUT', '/api/shadow-checkpoints/config', {
      workspaceId: 'ws1',
      workspacePath: ws,
    });
    assert.equal(r.status, 200);
    r = await api(srv.port, 'POST', '/api/shadow-checkpoints', {
      workspaceId: 'ws1',
      workspacePath: ws,
      label: 'before work',
    });
    assert.equal(r.status, 201);
    const c1 = r.body.checkpoint.id;
    assert.equal(r.body.dbSnapshot.status, 'ok');
    assert.equal(r.body.dbSnapshot.checkpointId, c1);

    // 4. The checkpoint list carries the db badge now.
    r = await api(srv.port, 'GET', `/api/shadow-checkpoints?workspaceId=ws1`);
    assert.equal(r.status, 200);
    const listed = r.body.checkpoints.find((c: any) => c.id === c1);
    assert.ok(listed);
    assert.equal(listed.db.status, 'ok');
    assert.equal(listed.db.relPath, 'data/app.db');

    // 5. Snapshots endpoint exposes metadata.
    r = await api(srv.port, 'GET', `/api/db-time-travel/snapshots?workspaceId=ws1&checkpointId=${c1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.snapshots.length, 1);
    assert.equal(r.body.snapshots[0].status, 'ok');

    // 6. Write new data after the checkpoint, then restore-db needs confirm.
    const devDb = new DatabaseSync(path.join(ws, 'data', 'app.db'));
    devDb.exec("INSERT INTO items (name) VALUES ('post')");
    devDb.close();
    assert.deepEqual(names(path.join(ws, 'data', 'app.db')), ['a', 'b', 'post']);
    r = await api(srv.port, 'POST', '/api/db-time-travel/restore-db', {
      workspaceId: 'ws1',
      workspacePath: ws,
      checkpointId: c1,
      confirm: false,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'DB_CONFIRM_REQUIRED');

    // 7. With confirm -> rows back, pre-restore keeps 'post'.
    r = await api(srv.port, 'POST', '/api/db-time-travel/restore-db', {
      workspaceId: 'ws1',
      workspacePath: ws,
      checkpointId: c1,
      confirm: true,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.restored);
    assert.ok(r.body.preRestore);
    assert.deepEqual(names(path.join(ws, 'data', 'app.db')), ['a', 'b']);

    // 8. Combined code+data restore on the shadow restore endpoint.
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v2\n');
    const devDb2 = new DatabaseSync(path.join(ws, 'data', 'app.db'));
    devDb2.exec("INSERT INTO items (name) VALUES ('post2')");
    devDb2.close();
    r = await api(srv.port, 'POST', `/api/shadow-checkpoints/${c1}/restore`, {
      workspaceId: 'ws1',
      workspacePath: ws,
      restoreDb: true,
      // no confirm -> fail fast, nothing modified
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'DB_CONFIRM_REQUIRED');
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v2\n');
    r = await api(srv.port, 'POST', `/api/shadow-checkpoints/${c1}/restore`, {
      workspaceId: 'ws1',
      workspacePath: ws,
      restoreDb: true,
      confirm: true,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.dbRestore);
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');
    assert.deepEqual(names(path.join(ws, 'data', 'app.db')), ['a', 'b']);

    // 9. Promote needs confirm too; prod receives the snapshot's data.
    seedDb(path.join(ws, 'data', 'app.prod.db'));
    const pdb = new DatabaseSync(path.join(ws, 'data', 'app.prod.db'));
    pdb.exec("INSERT INTO items (name) VALUES ('prod-row')");
    pdb.close();
    r = await api(srv.port, 'POST', '/api/db-time-travel/promote', {
      workspaceId: 'ws1',
      workspacePath: ws,
      checkpointId: c1,
      confirm: true,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.promoted);
    assert.ok(r.body.prePromote);
    assert.deepEqual(names(path.join(ws, 'data', 'app.prod.db')), ['a', 'b']);

    // 10. Audit trail records the lifecycle.
    r = await api(srv.port, 'GET', '/api/audit?limit=100');
    assert.equal(r.status, 200);
    const actions = (Array.isArray(r.body) ? r.body : []).map((e: any) => e.action ?? e.type);
    for (const want of ['DB_CONFIG_UPDATED', 'DB_SNAPSHOT_CREATED', 'DB_RESTORED', 'DB_PROMOTE']) {
      assert.ok(actions.includes(want), `missing audit action ${want}; have ${actions.slice(0, 15)}`);
    }
  } finally {
    await stopServer(srv);
  }
});
