/**
 * R7-#8 query history tests (dist).
 * Run: npm run build -w @ai-factory/dbbrowser && node --test packages/dbbrowser/dist/tests/history.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryCorruptError, QueryHistory } from '../src/index.js';

function homeTmp(prefix: string): string {
  const base = join(process.env['HOME'] ?? tmpdir(), 'r7w2-8-shots', 'tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

test('record/list/favorite/remove/clear, newest first', () => {
  const h = new QueryHistory({ filePath: null, now: (() => { let t = 1000; return () => t++; })() });
  const a = h.record({ connection: 'shop', sql: 'SELECT 1', verdict: 'read', ok: true, rowCount: 1, durationMs: 3 });
  const b = h.record({ connection: 'shop', sql: 'INSERT INTO t VALUES (1)', verdict: 'write', ok: false, errorCode: 'WRITE_MODE_DISABLED' });
  assert.equal(h.list().length, 2);
  assert.equal(h.list()[0]!.id, b.id); // newest first
  assert.equal(h.list({ connection: 'other' }).length, 0);
  assert.equal(h.list({ favoritesOnly: true }).length, 0);
  assert.equal(h.setFavorite(a.id, true)?.favorite, true);
  assert.equal(h.list({ favoritesOnly: true }).length, 1);
  assert.equal(h.get('nope'), null);
  assert.equal(h.setFavorite('nope', true), null);
  assert.equal(h.remove('nope'), false);
  assert.equal(h.remove(a.id), true);
  assert.equal(h.list().length, 1);
  assert.equal(h.clear('shop'), 1);
  assert.equal(h.list().length, 0);
});

test('sql truncation and entry cap', () => {
  const h = new QueryHistory({ filePath: null, maxEntries: 3, maxSqlChars: 10 });
  for (let i = 0; i < 5; i++) {
    h.record({ connection: 'c', sql: 'SELECT 123456789012345', verdict: 'read', ok: true });
  }
  const list = h.list();
  assert.equal(list.length, 3);
  assert.equal(list[0]!.sql.length, 10);
});

test('file persistence round-trips and corrupt file fails closed without overwrite', () => {
  const dir = homeTmp('hist-');
  const file = join(dir, 'db-history.json');
  const h = new QueryHistory({ filePath: file });
  h.record({ connection: 'shop', sql: 'SELECT 1', verdict: 'read', ok: true, rowCount: 1, durationMs: 1 });
  assert.ok(existsSync(file));
  const h2 = new QueryHistory({ filePath: file });
  assert.equal(h2.list().length, 1);
  assert.equal(h2.list()[0]!.sql, 'SELECT 1');

  writeFileSync(file, '{not json', 'utf8');
  const h3 = new QueryHistory({ filePath: file });
  assert.throws(() => h3.list(), (e: unknown) => e instanceof HistoryCorruptError);
  assert.equal(readFileSync(file, 'utf8'), '{not json'); // never overwritten
  // A later record attempt must not overwrite it either (fail-closed).
  assert.throws(
    () => h3.record({ connection: 'shop', sql: 'SELECT 2', verdict: 'read', ok: true }),
    (e: unknown) => e instanceof HistoryCorruptError,
  );
  assert.equal(readFileSync(file, 'utf8'), '{not json');
});
