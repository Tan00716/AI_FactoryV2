/**
 * R4-B9 TODO tracker — core unit tests (src-direct under node's
 * type-stripping ESM loader; todo-scan.ts has no sibling value imports).
 *
 * Fixture repo: apps/server/tests/fixtures/todo/
 *   a.ts            — TODO/FIXME/BUG/HACK in comments + string-literal
 *                     TODO (regex sees it) + lowercase todo (no match)
 *   sub/b.py        — TODO/FIXME + XXX (custom-pattern target)
 *   skip.bin        — NUL byte → binary-skipped
 *   big.txt         — >1MiB → oversize-skipped
 *   node_modules/evil.js — SKIP_DIRS pruned
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/todo-scan.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_TODO_PATTERNS,
  TodoScanError,
  scanTodoFile,
  scanTodos,
  validateTodoPatterns,
} from '../src/todo-scan.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'todo');

test('default scan finds all task comments with exact positions', () => {
  const { items, stats } = scanTodos(FIXTURE);
  const simple = items.map((i) => [i.file, i.line, i.column, i.severity, i.tag, i.message]);
  assert.deepEqual(simple, [
    ['a.ts', 1, 4, 'info', 'TODO', 'refactor this later'],
    ['a.ts', 3, 4, 'error', 'FIXME', 'handle negative inputs'],
    ['a.ts', 4, 12, 'info', 'TODO', 'inside a string still matches"; // regex sees it too'],
    ['a.ts', 5, 4, 'error', 'BUG', 'off-by-one on empty arrays */'],
    ['a.ts', 6, 4, 'warning', 'HACK', 'temporary workaround for the demo'],
    ['a.ts', 8, 4, 'info', 'TODO', ''],
    ['sub/b.py', 1, 3, 'info', 'TODO', 'python file works too'],
    ['sub/b.py', 2, 10, 'error', 'FIXME', 'urgent'],
  ]);
  // lowercase `todo` on a.ts line 7 and `# XXX` on b.py line 3 do not match.
  assert.equal(stats.items, 8);
  assert.equal(stats.filesScanned, 4); // a.ts, big.txt, skip.bin, sub/b.py
  assert.equal(stats.skippedBinary, 2); // big.txt (oversize) + skip.bin (NUL)
  assert.equal(stats.linesScanned, 13); // 8+1 a.ts, 3+1 b.py (split keeps trailing '')
  assert.equal(stats.truncated, false);
  assert.ok(stats.durationMs >= 0);
});

test('scan is deterministic across runs', () => {
  const a = scanTodos(FIXTURE, { now: () => 0 });
  const b = scanTodos(FIXTURE, { now: () => 0 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('scanTodoFile scans a single file', () => {
  const items = scanTodoFile(join(FIXTURE, 'a.ts'), FIXTURE);
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => i.file === 'a.ts'));
});

test('custom patterns: XXX target found, severity honored', () => {
  const patterns = validateTodoPatterns([
    { name: 'XXX', regexp: '\\bXXX\\b\\s*:?\\s*(.*)$', severity: 'warning', enabled: true },
  ]);
  assert.equal(patterns[0].builtin, false);
  const { items } = scanTodos(FIXTURE, { patterns });
  assert.deepEqual(
    items.map((i) => [i.file, i.line, i.tag, i.severity, i.message]),
    [['sub/b.py', 3, 'XXX', 'warning', 'custom pattern target']],
  );
});

test('disabled builtin patterns are skipped', () => {
  const patterns = DEFAULT_TODO_PATTERNS.map((p) =>
    p.name === 'TODO' ? { ...p, enabled: false } : p,
  );
  const { items } = scanTodos(FIXTURE, { patterns });
  assert.ok(items.every((i) => i.tag !== 'TODO'));
  assert.ok(items.some((i) => i.tag === 'FIXME'));
});

test('ignore predicate prunes directories', () => {
  const { items } = scanTodos(FIXTURE, {
    ignore: (abs) => abs.endsWith('sub'),
  });
  assert.ok(items.every((i) => !i.file.startsWith('sub/')));
  assert.ok(items.length > 0);
});

test('validateTodoPatterns rejects bad input (fail-closed, named)', () => {
  assert.throws(
    () => validateTodoPatterns([{ name: 'X', regexp: '([', severity: 'info' }]),
    (e) => e instanceof TodoScanError && /invalid regexp/.test(e.message) && /"X"/.test(e.message),
  );
  assert.throws(
    () => validateTodoPatterns([{ name: 'ALL', regexp: '.*', severity: 'info' }]),
    (e) => e instanceof TodoScanError && /empty string/.test(e.message),
  );
  assert.throws(
    () =>
      validateTodoPatterns([
        { name: 'TODO', regexp: 'a', severity: 'info' },
        { name: 'todo', regexp: 'b', severity: 'info' },
      ]),
    (e) => e instanceof TodoScanError && /duplicate/i.test(e.message),
  );
  assert.throws(
    () => validateTodoPatterns([{ name: 'X', regexp: 'x', severity: 'critical' }]),
    (e) => e instanceof TodoScanError && /severity/.test(e.message),
  );
  assert.throws(() => validateTodoPatterns([]), (e) => e instanceof TodoScanError);
  assert.throws(
    () =>
      validateTodoPatterns(
        Array.from({ length: 33 }, (_, i) => ({ name: `P${i}`, regexp: 'x', severity: 'info' })),
      ),
    (e) => e instanceof TodoScanError && /too many/.test(e.message),
  );
});

test('scanTodos fails closed on bad roots', () => {
  assert.throws(() => scanTodos(join(FIXTURE, 'nope')), (e) => e instanceof TodoScanError);
  assert.throws(() => scanTodos(join(FIXTURE, 'a.ts')), (e) => e instanceof TodoScanError);
});
