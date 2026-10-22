/**
 * sql-guard tests — the fail-closed dangerous-statement classifier.
 * Run: node --test packages/dbbrowser/dist/tests/guard.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql, maskSql } from '../src/index.js';

function verdict(sql: string) {
  const g = classifySql(sql);
  return [g.verdict, g.reason] as const;
}

test('reads pass', () => {
  assert.deepEqual(verdict('SELECT 1'), ['read', 'READ_SELECT']);
  assert.deepEqual(verdict('  select * from t limit 5 '), ['read', 'READ_SELECT']);
  assert.deepEqual(verdict('WITH a AS (SELECT 1) SELECT * FROM a'), ['read', 'READ_CTE']);
  assert.deepEqual(verdict('EXPLAIN QUERY PLAN SELECT 1'), ['read', 'READ_EXPLAIN']);
  assert.deepEqual(verdict("PRAGMA table_info('t')"), ['read', 'READ_PRAGMA']);
});

test('writes pass', () => {
  assert.deepEqual(verdict("INSERT INTO t (a) VALUES ('x')"), ['write', 'WRITE_INSERT']);
  assert.deepEqual(verdict('UPDATE t SET a=1 WHERE id=2'), ['write', 'WRITE_UPDATE']);
  assert.deepEqual(verdict('DELETE FROM t WHERE id IN (SELECT id FROM u)'), ['write', 'WRITE_DELETE']);
  assert.deepEqual(verdict('CREATE TABLE t (a TEXT)'), ['write', 'WRITE_CREATE']);
  assert.deepEqual(verdict('ALTER TABLE t ADD COLUMN b TEXT'), ['write', 'WRITE_ALTER_ADD']);
  assert.deepEqual(verdict('PRAGMA journal_mode=WAL'), ['write', 'WRITE_PRAGMA_MODE']);
});

test('destructive needs approval', () => {
  assert.deepEqual(verdict('DELETE FROM t'), ['destructive', 'DELETE_WITHOUT_WHERE']);
  assert.deepEqual(verdict('UPDATE t SET a=1'), ['destructive', 'UPDATE_WITHOUT_WHERE']);
  assert.deepEqual(verdict('DROP TABLE t'), ['destructive', 'DESTRUCTIVE_DDL']);
  assert.deepEqual(verdict('TRUNCATE t'), ['destructive', 'DESTRUCTIVE_DDL']);
  assert.deepEqual(verdict('ALTER TABLE t DROP COLUMN b'), ['destructive', 'ALTER_DESTRUCTIVE']);
  assert.deepEqual(verdict('ALTER TABLE t RENAME TO u'), ['destructive', 'ALTER_DESTRUCTIVE']);
});

test('blocked is fail-closed', () => {
  assert.deepEqual(verdict(''), ['blocked', 'EMPTY_SQL']);
  assert.deepEqual(verdict('SELECT 1; SELECT 2'), ['blocked', 'MULTIPLE_STATEMENTS']);
  assert.deepEqual(verdict("ATTACH DATABASE 'x.db' AS x"), ['blocked', 'FILE_SIDEEFFECT']);
  assert.deepEqual(verdict('VACUUM'), ['blocked', 'MAINTENANCE_BLOCKED']);
  assert.deepEqual(verdict('BEGIN'), ['blocked', 'TXN_BLOCKED']);
  assert.deepEqual(verdict('FROBNICATE t'), ['blocked', 'UNKNOWN_STATEMENT']);
  assert.deepEqual(verdict('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a'), ['blocked', 'CTE_NON_SELECT']);
});

test('semicolons inside string literals do not count as multi-statement', () => {
  const [v] = verdict("SELECT * FROM t WHERE note = 'a;b'");
  assert.equal(v, 'read');
});

test('comments are masked before keyword detection', () => {
  const [v] = verdict('-- DROP TABLE t\nSELECT 1');
  assert.equal(v, 'read');
  const [v2, r2] = verdict('/* ; */ DELETE FROM t');
  assert.deepEqual([v2, r2], ['destructive', 'DELETE_WITHOUT_WHERE']);
});

test('maskSql strips quoted content', () => {
  const m = maskSql(`SELECT 'it''s', "q;x" /* ; */ FROM t -- ;`);
  assert.ok(!m.includes(';') || m.indexOf(';') > m.indexOf('FROM'), 'only real semicolons survive');
});
