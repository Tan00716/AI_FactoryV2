/**
 * DB time-travel unit tests (round-2 task 10).
 *
 * Imports ../src/db-time-travel.ts directly: the module uses node builtins
 * only (node:fs/path/crypto/sqlite), so it resolves under node's
 * type-stripping ESM loader (AGENTS.md dual-mode rule).
 *
 * Covers: config read/write/validation, path jail, WAL-checkpointed
 * snapshot consistency (rows survive the round trip), skip statuses
 * (no-config/disabled/not-found/symlink/too-large), restore with
 * pre-restore backup (reversibility), restore confirm gate, prod restore
 * refusal (dev==prod), promote confirm gate + prod write, promote without
 * prod config refuses.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/db-time-travel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DbTimeTravelError,
  DbTimeTravelStore,
  dbConfigPath,
  maxDbSnapshotBytes,
  promoteDbToProd,
  readDbConfig,
  resolveDbFile,
  restoreDbFromSnapshot,
  snapshotDbForCheckpoint,
  snapshotFilePath,
  validateDbConfig,
  validateDbRelPath,
  writeDbConfig,
} from '../src/db-time-travel.ts';

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtt-'));
  const dataDir = path.join(root, 'data');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  process.env.FACTORY_SHADOW_ROOTS = root;
  return { root, dataDir, ws };
}

function seedDb(absPath: string, wal = true): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const db = new DatabaseSync(absPath);
  try {
    if (wal) db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO items (name) VALUES ('a'), ('b')");
  } finally {
    db.close();
  }
}

function readNames(absPath: string): string[] {
  const db = new DatabaseSync(absPath);
  try {
    return db.prepare('SELECT name FROM items ORDER BY id').all().map((r) => (r as { name: string }).name);
  } finally {
    db.close();
  }
}

function writeConfig(ws: string, cfg: object): void {
  fs.mkdirSync(path.join(ws, '.ai-factory'), { recursive: true });
  fs.writeFileSync(dbConfigPath(ws), JSON.stringify(cfg), 'utf8');
}

test('config: read/write round-trip and defaults', () => {
  const { ws } = makeEnv();
  assert.equal(readDbConfig(ws), null);
  const saved = writeDbConfig(ws, { dev: 'data/app.db', snapshotOnCheckpoint: true } as never);
  assert.equal(saved.dev, 'data/app.db');
  assert.equal(saved.snapshotOnCheckpoint, true);
  const back = readDbConfig(ws)!;
  assert.equal(back.dev, 'data/app.db');
  assert.equal(back.snapshotOnCheckpoint, true);
});

test('config: invalid configs are rejected loudly, never treated as absent', () => {
  const { ws } = makeEnv();
  assert.throws(() => validateDbConfig({}), DbTimeTravelError);
  assert.throws(() => validateDbConfig({ dev: '../evil.db' }), DbTimeTravelError);
  assert.throws(() => validateDbConfig({ dev: '/abs/path.db' }), DbTimeTravelError);
  assert.throws(() => validateDbConfig({ dev: 'a.db', snapshotOnCheckpoint: 'yes' }), DbTimeTravelError);
  assert.throws(() => validateDbConfig({ dev: 'a.db', maxBytes: -5 }), DbTimeTravelError);
  assert.throws(() => validateDbConfig({ dev: 'a.db', maxBytes: Number.POSITIVE_INFINITY }), DbTimeTravelError);
  assert.throws(() => validateDbRelPath('', 'x'), DbTimeTravelError);
  // Corrupt JSON on disk -> DB_CONFIG_CORRUPT, not null.
  fs.mkdirSync(path.join(ws, '.ai-factory'), { recursive: true });
  fs.writeFileSync(dbConfigPath(ws), '{nope', 'utf8');
  assert.throws(() => readDbConfig(ws), (e: unknown) => (e as DbTimeTravelError).code === 'DB_CONFIG_CORRUPT');
});

test('config: path jail — db paths cannot escape the workspace', () => {
  const { ws } = makeEnv();
  assert.throws(() => resolveDbFile(ws, '../outside.db'), DbTimeTravelError);
  assert.throws(() => resolveDbFile(ws, 'sub/../../outside.db'), DbTimeTravelError);
  const ok = resolveDbFile(ws, 'data/app.db');
  assert.ok(ok.startsWith(path.resolve(ws) + path.sep));
});

test('maxDbSnapshotBytes: config > env > default', () => {
  delete process.env.FACTORY_DB_SNAPSHOT_MAX_BYTES;
  assert.equal(maxDbSnapshotBytes(null), 100 * 1024 * 1024);
  process.env.FACTORY_DB_SNAPSHOT_MAX_BYTES = '1000';
  assert.equal(maxDbSnapshotBytes(null), 1000);
  assert.equal(maxDbSnapshotBytes({ dev: 'a.db', snapshotOnCheckpoint: true, maxBytes: 500 }), 500);
  delete process.env.FACTORY_DB_SNAPSHOT_MAX_BYTES;
});

test('snapshot: WAL-mode db is checkpointed and round-trips rows', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db', prod: 'data/app.prod.db' });
  seedDb(path.join(ws, 'data', 'app.db'));
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  const meta = snapshotDbForCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_abc',
  });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.relPath, 'data/app.db');
  assert.equal(meta.env, 'dev');
  assert.ok(meta.size > 0);
  assert.equal(meta.sha256?.length, 64);
  const snapPath = snapshotFilePath(meta)!;
  assert.ok(fs.existsSync(snapPath));
  // Snapshot is a complete, openable db with the rows intact (WAL folded).
  assert.deepEqual(readNames(snapPath), ['a', 'b']);
  assert.equal(store.latestOkForCheckpoint('scp_abc')!.id, meta.id);
});

test('snapshot: skip statuses are explicit and recorded', () => {
  const { ws, dataDir } = makeEnv();
  // no config
  let store = new DbTimeTravelStore(path.join(dataDir, 'a.json'));
  let m = snapshotDbForCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'c1' });
  assert.equal(m.status, 'skipped-no-config');
  assert.ok(m.reason);
  // disabled
  writeConfig(ws, { dev: 'data/app.db', snapshotOnCheckpoint: false });
  store = new DbTimeTravelStore(path.join(dataDir, 'b.json'));
  m = snapshotDbForCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'c2' });
  assert.equal(m.status, 'skipped-disabled');
  // not found
  writeConfig(ws, { dev: 'data/missing.db' });
  store = new DbTimeTravelStore(path.join(dataDir, 'c.json'));
  m = snapshotDbForCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'c3' });
  assert.equal(m.status, 'skipped-not-found');
  assert.ok(m.reason!.includes('data/missing.db'));
  // too large (tiny cap via config)
  writeConfig(ws, { dev: 'data/app.db', maxBytes: 10 });
  seedDb(path.join(ws, 'data', 'app.db'));
  store = new DbTimeTravelStore(path.join(dataDir, 'd.json'));
  m = snapshotDbForCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'c4' });
  assert.equal(m.status, 'skipped-too-large');
  assert.ok(m.reason!.includes('10'));
});

test('snapshot: symlinked db is never followed', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/link.db' });
  seedDb(path.join(ws, 'real.db'));
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.symlinkSync(path.join(ws, 'real.db'), path.join(ws, 'data', 'link.db'));
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  const m = snapshotDbForCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'c1',
  });
  assert.equal(m.status, 'skipped-symlink');
});

test('restore: confirm required, data returns to snapshot, pre-restore keeps current state', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db', prod: 'data/app.prod.db' });
  const devAbs = path.join(ws, 'data', 'app.db');
  seedDb(devAbs);
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  const snap = snapshotDbForCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_1',
  });
  assert.equal(snap.status, 'ok');

  // Write NEW data after the checkpoint.
  const db = new DatabaseSync(devAbs);
  db.exec("INSERT INTO items (name) VALUES ('post')");
  db.close();
  assert.deepEqual(readNames(devAbs), ['a', 'b', 'post']);

  // No confirm -> refused, nothing touched.
  assert.throws(
    () => restoreDbFromSnapshot(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_1', confirm: false }),
    (e: unknown) => (e as DbTimeTravelError).code === 'DB_CONFIRM_REQUIRED',
  );
  assert.deepEqual(readNames(devAbs), ['a', 'b', 'post']);

  // With confirm -> rows back to snapshot state, pre-restore saved 'post'.
  const r = restoreDbFromSnapshot(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_1',
    confirm: true,
  });
  assert.deepEqual(readNames(devAbs), ['a', 'b']);
  assert.ok(r.preRestore);
  assert.equal(r.preRestore!.status, 'ok');
  assert.equal(r.preRestore!.kind, 'pre-restore');
  const prePath = snapshotFilePath(r.preRestore!)!;
  assert.ok(fs.existsSync(prePath));
  assert.deepEqual(readNames(prePath), ['a', 'b', 'post']);
});

test('restore: refuses when dev and prod resolve to the same file', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db', prod: 'data/app.db' });
  seedDb(path.join(ws, 'data', 'app.db'));
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  const snap = snapshotDbForCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_1',
  });
  assert.equal(snap.status, 'ok');
  assert.throws(
    () => restoreDbFromSnapshot(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_1', confirm: true }),
    (e: unknown) => (e as DbTimeTravelError).code === 'DB_PROD_RESTORE_REFUSED',
  );
});

test('restore: no usable snapshot -> DB_NO_SNAPSHOT, nothing modified', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db' });
  seedDb(path.join(ws, 'data', 'app.db'));
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  assert.throws(
    () => restoreDbFromSnapshot(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'nope', confirm: true }),
    (e: unknown) => (e as DbTimeTravelError).code === 'DB_NO_SNAPSHOT',
  );
});

test('promote: confirm required; prod written from snapshot; current prod backed up first', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db', prod: 'data/app.prod.db' });
  seedDb(path.join(ws, 'data', 'app.db'));
  const prodAbs = path.join(ws, 'data', 'app.prod.db');
  seedDb(prodAbs);
  const pdb = new DatabaseSync(prodAbs);
  pdb.exec("INSERT INTO items (name) VALUES ('prod-row')");
  pdb.close();
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  const snap = snapshotDbForCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_1',
  });
  assert.equal(snap.status, 'ok');

  // No confirm -> refused, prod untouched.
  assert.throws(
    () => promoteDbToProd(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_1', confirm: 'yes' }),
    (e: unknown) => (e as DbTimeTravelError).code === 'DB_CONFIRM_REQUIRED',
  );
  assert.deepEqual(readNames(prodAbs), ['a', 'b', 'prod-row']);

  const r = promoteDbToProd(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: 'scp_1',
    confirm: true,
  });
  assert.deepEqual(readNames(prodAbs), ['a', 'b']);
  assert.equal(r.prodRelPath, 'data/app.prod.db');
  assert.ok(r.prePromote);
  assert.equal(r.prePromote!.kind, 'pre-promote');
  assert.deepEqual(readNames(snapshotFilePath(r.prePromote!)!), ['a', 'b', 'prod-row']);
});

test('promote: refuses without a prod path in config', () => {
  const { ws, dataDir } = makeEnv();
  writeConfig(ws, { dev: 'data/app.db' });
  seedDb(path.join(ws, 'data', 'app.db'));
  const store = new DbTimeTravelStore(path.join(dataDir, 'dbtt.json'));
  snapshotDbForCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_1' });
  assert.throws(
    () => promoteDbToProd(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_1', confirm: true }),
    (e: unknown) => (e as DbTimeTravelError).code === 'DB_NO_PROD',
  );
});
