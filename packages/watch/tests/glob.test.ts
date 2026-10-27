import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchGlobs } from '../src/glob';

test('star does not cross slash, doublestar does', () => {
  assert.equal(matchGlobs(['src/*.ts'], 'src/a.ts'), true);
  assert.equal(matchGlobs(['src/*.ts'], 'src/deep/a.ts'), false);
  assert.equal(matchGlobs(['src/**/*.ts'], 'src/deep/a.ts'), true);
  assert.equal(matchGlobs(['src/**/*.ts'], 'src/a.ts'), true);
});

test('bare pattern matches basename at any depth', () => {
  assert.equal(matchGlobs(['*.ts'], 'a.ts'), true);
  assert.equal(matchGlobs(['*.ts'], 'src/deep/a.ts'), true);
  assert.equal(matchGlobs(['*.ts'], 'src/a.js'), false);
});

test('question mark matches one non-slash char', () => {
  assert.equal(matchGlobs(['a?.ts'], 'ab.ts'), true);
  assert.equal(matchGlobs(['a?.ts'], 'a/b.ts'), false);
});

test('doublestar prefix matches zero directories', () => {
  assert.equal(matchGlobs(['**/*.ts'], 'a.ts'), true);
  assert.equal(matchGlobs(['**/*.ts'], 'x/y/a.ts'), true);
});

test('character class and trailing dir glob', () => {
  assert.equal(matchGlobs(['src/[ab].ts'], 'src/a.ts'), true);
  assert.equal(matchGlobs(['src/[ab].ts'], 'src/c.ts'), false);
  assert.equal(matchGlobs(['docs/**'], 'docs/a/b.md'), true);
});

test('unbalanced bracket throws', () => {
  assert.throws(() => globToRegExp('src/[ab.ts'), /unbalanced/);
});

test('backslash paths normalize to posix', () => {
  assert.equal(matchGlobs(['src/*.ts'], 'src\\a.ts'), true);
});
