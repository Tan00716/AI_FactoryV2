/**
 * grepProject tests (round-5 task R5-A8). Run against compiled dist:
 *   node --test packages/codesearch/dist/tests/grep.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodeSearchError,
  globToRegExp,
  grepProject,
  normalizeQuery,
} from '../src/index.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'codesearch-grep-'));
  writeFileSync(join(root, 'a.ts'), 'const todo = 1;\n// TODO: fix this\nconst other = "todo list";\n');
  writeFileSync(join(root, 'b.md'), '# Title\nsome TODO here\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.ts'), 'function todo() {}\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x74, 0x6f, 0x64, 0x6f]));
  try {
    symlinkSync(join(root, 'a.ts'), join(root, 'link.ts'));
  } catch {
    // symlink creation may be restricted; the no-follow rule is still asserted structurally
  }
  return root;
}

test('literal search is case-insensitive by default', () => {
  const r = grepProject(fixture(), { query: 'todo' });
  assert.equal(r.totalMatches, 5); // a.ts x3 (code+comment+string) + b.md x1 + sub/c.ts x1
  assert.deepEqual(r.groups.map((g) => g.file), ['a.ts', 'b.md', 'sub/c.ts']);
  assert.equal(r.groups[0].matches[0].line, 1);
  assert.equal(r.groups[0].matches[0].column, 7);
  assert.equal(r.stats.truncated, false);
});

test('caseSensitive narrows matches', () => {
  const r = grepProject(fixture(), { query: 'todo', caseSensitive: true });
  assert.equal(r.totalMatches, 3); // a.ts line 1 + line 3 + sub/c.ts line 1
});

test('regex mode matches patterns', () => {
  const r = grepProject(fixture(), { query: 'TODO:\\s*\\w+', regex: true });
  assert.equal(r.totalMatches, 1); // a.ts line 2 only (b.md's "TODO here" has no colon)
});

test('glob filters files', () => {
  const r = grepProject(fixture(), { query: 'todo', glob: ['*.md'] });
  assert.deepEqual(r.groups.map((g) => g.file), ['b.md']);
  const r2 = grepProject(fixture(), { query: 'todo', glob: 'sub/**' });
  assert.deepEqual(r2.groups.map((g) => g.file), ['sub/c.ts']);
});

test('binary files are skipped, never followed symlinks', () => {
  const r = grepProject(fixture(), { query: 'todo' });
  assert.ok(r.stats.skippedBinary >= 1);
  const files = r.groups.map((g) => g.file);
  assert.ok(!files.includes('link.ts'), 'symlink must not be followed');
});

test('maxMatches truncates fail-closed with truncated=true', () => {
  const r = grepProject(fixture(), { query: 'todo', maxMatches: 2 });
  assert.equal(r.totalMatches, 2);
  assert.equal(r.stats.truncated, true);
});

test('validation fails closed', () => {
  assert.throws(() => normalizeQuery({ query: '' }), CodeSearchError);
  assert.throws(() => normalizeQuery({ query: 'x'.repeat(201) }), CodeSearchError);
  assert.throws(() => normalizeQuery({ query: '([' , regex: true }), CodeSearchError);
  assert.throws(() => normalizeQuery({ query: 'a*', regex: true }), CodeSearchError); // matches empty
  assert.throws(
    () => normalizeQuery({ query: 'x', glob: Array.from({ length: 9 }, (_, i) => `f${i}`) }),
    CodeSearchError,
  );
});

test('globToRegExp dialect', () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('sub/a.ts'));
  assert.ok(globToRegExp('**/*.ts').test('sub/a.ts'));
  assert.ok(globToRegExp('src/**').test('src/deep/a.ts'));
  assert.ok(globToRegExp('file?.txt').test('file1.txt'));
  assert.ok(!globToRegExp('file?.txt').test('file12.txt'));
});

test('ignore predicate prunes directories', () => {
  const r = grepProject(fixture(), { query: 'todo' }, {
    ignore: (abs, isDir) => isDir && abs.endsWith('sub'),
  });
  assert.ok(!r.groups.some((g) => g.file.startsWith('sub/')));
});
