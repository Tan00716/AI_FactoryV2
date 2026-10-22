/**
 * browser tests — DbBrowser orchestration: console guard wiring,
 * prod-write refusal, paged table editor, verified row write-back.
 * Run: node --test packages/dbbrowser/dist/tests/browser.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbBrowser, DbBlockedError, DbNeedsApprovalError } from '../src/index.js';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbbrowser-browser-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function freshBrowser(): DbBrowser {
  const b = new DbBrowser();
  const p = join(dir, `w-${Math.random().toString(36).slice(2)}.db`);
  b.registerSqlite('dev1', p, 'dev');
  b.registerSqlite('prod1', join(dir, `p-${Math.random().toString(36).slice(2)}.db`), 'prod');
  return b;
}

async function seed(b: DbBrowser): Promise<void> {
  await b.query('dev1', `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER DEFAULT 0)`, 't');
  for (let i = 1; i <= 25; i++) {
    await b.query('dev1', `INSERT INTO items (name, qty) VALUES ('item-${i}', ${i * 10})`, 't');
  }
}

test('query console: read runs, write runs on dev, destructive throws approval, blocked throws', async () => {
  const b = freshBrowser();
  try {
    await seed(b);
    const read = await b.query('dev1', 'SELECT COUNT(*) AS n FROM items', 't');
    assert.equal(read.verdict, 'read');
    assert.equal(read.result.rows[0]!['n'], 25);

    const write = await b.query('dev1', `INSERT INTO items (name) VALUES ('extra')`, 't');
    assert.equal(write.verdict, 'write');
    assert.equal(write.result.changes, 1);

    await assert.rejects(() => b.query('dev1', 'DELETE FROM items', 't'), DbNeedsApprovalError);
    await assert.rejects(() => b.query('dev1', 'DROP TABLE items', 't'), DbNeedsApprovalError);
    await assert.rejects(
      () => b.query('dev1', 'SELECT 1; SELECT 2', 't'),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'MULTIPLE_STATEMENTS',
    );
  } finally {
    await b.deregister('dev1');
    await b.deregister('prod1');
  }
});

test('prod connections refuse writes, reads still work', async () => {
  const b = freshBrowser();
  try {
    await b.query('prod1', 'CREATE TABLE p (a TEXT)', 't').catch(() => {});
    const r = await b.query('prod1', 'SELECT 1 AS one', 't');
    assert.equal(r.result.rows[0]!['one'], 1);
    await assert.rejects(
      () => b.query('prod1', `INSERT INTO p (a) VALUES ('x')`, 't'),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'PROD_WRITE_REFUSED',
    );
    await assert.rejects(
      () => b.updateRow('prod1', 'p', { a: 'x' }, { a: 'y' }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'PROD_WRITE_REFUSED',
    );
  } finally {
    await b.deregister('dev1');
    await b.deregister('prod1');
  }
});

test('pageTable paginates, filters, sorts with identifier validation', async () => {
  const b = freshBrowser();
  try {
    await seed(b);
    const p1 = await b.pageTable('dev1', 'items', { page: 1, pageSize: 10 });
    assert.equal(p1.rows.length, 10);
    assert.equal(p1.totalRows, 25);
    assert.equal(p1.totalPages, 3);
    const p3 = await b.pageTable('dev1', 'items', { page: 3, pageSize: 10 });
    assert.equal(p3.rows.length, 5);

    const f = await b.pageTable('dev1', 'items', {
      page: 1,
      pageSize: 50,
      filters: [{ column: 'qty', op: 'gt', value: 200 }],
    });
    assert.equal(f.totalRows, 5);

    const s = await b.pageTable('dev1', 'items', { page: 1, pageSize: 3, orderBy: 'qty', orderDir: 'desc' });
    assert.equal(s.rows[0]!['qty'], 250);

    await assert.rejects(
      () => b.pageTable('dev1', 'items"; DROP TABLE items; --', { page: 1, pageSize: 10 }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'BAD_IDENTIFIER',
    );
    await assert.rejects(
      () => b.pageTable('dev1', 'items', { page: 1, pageSize: 10, orderBy: 'nope', orderDir: 'asc' }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'BAD_ORDER',
    );
  } finally {
    await b.deregister('dev1');
    await b.deregister('prod1');
  }
});

test('updateRow writes through and re-reads the row (verified, not assumed)', async () => {
  const b = freshBrowser();
  try {
    await seed(b);
    const { row, changes } = await b.updateRow('dev1', 'items', { id: 3 }, { qty: 999, name: 'renamed' });
    assert.equal(changes, 1);
    assert.equal(row!['qty'], 999);
    assert.equal(row!['name'], 'renamed');
    // unknown column refused
    await assert.rejects(
      () => b.updateRow('dev1', 'items', { id: 3 }, { nope: 1 }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'BAD_COLUMN',
    );
    // pk required
    await assert.rejects(
      () => b.updateRow('dev1', 'items', {}, { qty: 1 }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'PK_REQUIRED',
    );
    // non-matching pk -> honest failure, not a silent no-op
    await assert.rejects(
      () => b.updateRow('dev1', 'items', { id: 424242 }, { qty: 1 }),
      (e: unknown) => e instanceof DbBlockedError && e.code === 'ROW_NOT_FOUND_AFTER_UPDATE',
    );
  } finally {
    await b.deregister('dev1');
    await b.deregister('prod1');
  }
});

test('tables/schema/erGraph round out the browser surface', async () => {
  const b = freshBrowser();
  try {
    await seed(b);
    const tables = await b.tables('dev1');
    assert.deepEqual(tables, [{ name: 'items', type: 'table' }]);
    const schema = await b.schema('dev1');
    assert.equal(schema.tables.length, 1);
    const g = await b.erGraph('dev1');
    assert.equal(g.nodes.length, 1);
    assert.deepEqual(g.edges, []);
    const ddl = await b.ddlFor('dev1', 'items');
    assert.ok(ddl.ddl.includes('CREATE TABLE "items"'));
  } finally {
    await b.deregister('dev1');
    await b.deregister('prod1');
  }
});

test('deregister closes and unknown connections are loud', async () => {
  const b = freshBrowser();
  await b.deregister('dev1');
  await assert.rejects(
    () => b.query('dev1', 'SELECT 1', 't'),
    (e: unknown) => e instanceof DbBlockedError && e.code === 'UNKNOWN_CONNECTION',
  );
  await b.deregister('prod1');
});
