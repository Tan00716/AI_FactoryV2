/**
 * schema tests — introspection, DDL generation, diff.
 * Fixture SQLite DBs are built fresh in a temp dir per run (hermetic).
 * Run: node --test packages/dbbrowser/dist/tests/schema.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDriver,
  introspectSchema,
  createTableDdl,
  diffSchemas,
  schemaToErGraph,
} from '../src/index.js';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbbrowser-schema-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function fixturePath(name: string): string {
  return join(dir, name);
}

async function buildFixture(path: string): Promise<SqliteDriver> {
  const d = new SqliteDriver('fx', path);
  await d.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    created_at TEXT DEFAULT 'now'
  )`);
  await d.exec(`CREATE UNIQUE INDEX idx_users_email ON users (email)`);
  await d.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total REAL NOT NULL DEFAULT 0
  )`);
  await d.exec(`CREATE VIEW user_orders AS SELECT u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id`);
  return d;
}

test('introspectSchema finds tables, columns, pk, indexes, fks, views', async () => {
  const d = await buildFixture(fixturePath('a.db'));
  try {
    const s = await introspectSchema(d);
    assert.equal(s.dialect, 'sqlite');
    assert.deepEqual(
      s.tables.map((t) => t.name),
      ['orders', 'users'],
    );
    const users = s.tables.find((t) => t.name === 'users')!;
    assert.deepEqual(users.columns.map((c) => c.name), ['id', 'name', 'email', 'created_at']);
    assert.equal(users.columns[0]!.pk, 1);
    assert.equal(users.columns[1]!.notNull, true);
    assert.equal(users.columns[3]!.defaultValue, "'now'");
    assert.ok(users.indexes.some((i) => i.name === 'idx_users_email' && i.unique));
    const orders = s.tables.find((t) => t.name === 'orders')!;
    assert.deepEqual(orders.foreignKeys, [{ column: 'user_id', refTable: 'users', refColumn: 'id' }]);
    assert.deepEqual(
      s.views.map((v) => v.name),
      ['user_orders'],
    );
    assert.ok(s.views[0]!.sql!.includes('SELECT'));
  } finally {
    await d.close();
  }
});

test('generated CREATE TABLE DDL executes on an empty database', async () => {
  const src = await buildFixture(fixturePath('b.db'));
  let s;
  try {
    s = await introspectSchema(src);
  } finally {
    await src.close();
  }
  const ddl = s.tables.map((t) => createTableDdl('sqlite', t)).join('\n\n');
  assert.ok(ddl.includes('CREATE TABLE "users"'));
  assert.ok(ddl.includes('PRIMARY KEY ("id")'));
  const empty = new SqliteDriver('empty', fixturePath('empty.db'));
  try {
    for (const stmt of ddl.split(/;\s*\n/)) {
      const s2 = stmt.trim();
      if (s2) await empty.exec(s2 + ';');
    }
    const again = await introspectSchema(empty);
    assert.deepEqual(
      again.tables.map((t) => t.name),
      ['orders', 'users'],
    );
    const usersAgain = again.tables.find((t) => t.name === 'users')!;
    assert.deepEqual(
      usersAgain.columns.map((c) => c.name),
      ['id', 'name', 'email', 'created_at'],
    );
    assert.deepEqual(usersAgain.foreignKeys, []);
    const ordersAgain = again.tables.find((t) => t.name === 'orders')!;
    assert.deepEqual(ordersAgain.foreignKeys, [{ column: 'user_id', refTable: 'users', refColumn: 'id' }]);
  } finally {
    await empty.close();
  }
});

test('diffSchemas emits additive DDL and reports destructive items without scripting them', async () => {
  const d1 = await buildFixture(fixturePath('c1.db'));
  const d2 = new SqliteDriver('tgt', fixturePath('c2.db'));
  try {
    await d2.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await d2.exec(`CREATE TABLE legacy (id INTEGER PRIMARY KEY)`);
    const s = await introspectSchema(d1);
    const t = await introspectSchema(d2);
    const diff = diffSchemas(s, t);
    // orders table missing in target -> CREATE TABLE
    assert.ok(diff.addTables.some((x) => x.name === 'orders'));
    // users.email / users.created_at missing -> ADD COLUMN
    assert.ok(diff.addColumns.some((x) => x.table === 'users' && x.column.name === 'email'));
    // legacy table + legacy has no users.* extras: dropped table reported, not scripted
    assert.deepEqual(diff.droppedTables, ['legacy']);
    assert.ok(!diff.ddl.some((x) => /DROP/i.test(x)), 'no destructive DDL emitted');
    // additive DDL applies cleanly on the target
    for (const stmt of diff.ddl) await d2.exec(stmt);
    const after = await introspectSchema(d2);
    const usersAfter = after.tables.find((x) => x.name === 'users')!;
    assert.ok(usersAfter.columns.some((c) => c.name === 'email'));
    assert.ok(after.tables.some((x) => x.name === 'orders'));
  } finally {
    await d1.close();
    await d2.close();
  }
});

test('schemaToErGraph exposes the fk topology', async () => {
  const d = await buildFixture(fixturePath('d.db'));
  try {
    const g = schemaToErGraph(await introspectSchema(d));
    assert.equal(g.nodes.length, 2);
    const users = g.nodes.find((n) => n.id === 'users')!;
    assert.deepEqual(users.pk, ['id']);
    assert.deepEqual(g.edges, [{ from: 'orders', to: 'users', label: 'user_id → id' }]);
  } finally {
    await d.close();
  }
});
