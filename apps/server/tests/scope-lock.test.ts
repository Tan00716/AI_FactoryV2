/**
 * Scope Lock — unit tests (second-round strengthening, item 8).
 *
 * Imports ../src/scope-lock.ts straight from src (type-stripping):
 * the module has no sibling value imports (node builtins + type-only
 * @ai-factory/core), so this is safe per the dual-mode import rule.
 * Covers: glob semantics, validation, jail/symlink resolution,
 * detection, presets, and the no-scope = zero-impact contract.
 *
 * Run: node --test apps/server/tests/scope-lock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ScopeLockDeniedError,
  checkScopedWrite,
  detectOutOfScopePaths,
  hasScope,
  judgePath,
  matchGlob,
  resolveScopedRel,
  scopeAllows,
  validateGlobPattern,
  validateScopeInput,
  SCOPE_PRESETS,
} from '../src/scope-lock.ts';

// ------------------------------------------------------------ globbing

test('glob: ** spans segments, * stays within one, ? is one char', () => {
  assert.equal(matchGlob('src/**', 'src/a.ts'), true);
  assert.equal(matchGlob('src/**', 'src/deep/nested/a.ts'), true);
  assert.equal(matchGlob('src/**', 'lib/a.ts'), false);
  assert.equal(matchGlob('src/*', 'src/a.ts'), true);
  assert.equal(matchGlob('src/*', 'src/deep/a.ts'), false);
  assert.equal(matchGlob('src/?.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('src/?.ts', 'src/ab.ts'), false);
  assert.equal(matchGlob('**/*.test.ts', 'src/x.test.ts'), true);
  assert.equal(matchGlob('**/*.test.ts', 'x.test.ts'), true);
  assert.equal(matchGlob('**/*.test.ts', 'x.spec.ts'), false);
});

test('glob: bare literal matches itself and its subtree; ./ and \\ normalized', () => {
  assert.equal(matchGlob('src', 'src'), true);
  assert.equal(matchGlob('src', 'src/a/b.ts'), true);
  assert.equal(matchGlob('src', 'srcx/a.ts'), false);
  assert.equal(matchGlob('./src/**', 'src/a.ts'), true);
  assert.equal(matchGlob('src\\**', 'src/a.ts'), true);
  assert.equal(matchGlob('package.json', 'package.json'), true);
  assert.equal(matchGlob('package.json', 'x/package.json'), false);
});

test('glob: *.ext matches at root level only (no implicit **/)', () => {
  assert.equal(matchGlob('*.json', 'a.json'), true);
  assert.equal(matchGlob('*.json', 'x/a.json'), false);
});

// ----------------------------------------------------------- validation

test('validation: rejects malformed scopes, normalizes valid ones', () => {
  assert.equal(validateScopeInput('nope').error !== undefined, true);
  assert.equal(validateScopeInput({ include: 'src/**' }).error !== undefined, true);
  assert.equal(validateScopeInput({ include: [42] }).error !== undefined, true);
  assert.equal(validateScopeInput({ include: ['/abs/**'] }).error !== undefined, true);
  assert.equal(validateScopeInput({ include: ['src/../x'] }).error !== undefined, true);
  assert.equal(validateScopeInput({ include: ['C:\\win'] }).error !== undefined, true);
  const ok = validateScopeInput({ include: ['./src/** ', 'src/**'], exclude: [] });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.scope, { include: ['src/**'] });
  const cleared = validateScopeInput(null);
  assert.deepEqual(cleared.scope, {});
  assert.equal(validateGlobPattern(''), 'empty pattern');
  assert.equal(validateGlobPattern('src/**'), null);
});

// ------------------------------------------------------------- judging

test('judge: exclude always wins; empty include = no constraint; no scope = allow', () => {
  const scoped = { include: ['src/**'], exclude: ['src/secret.ts', '**/*.min.js'] };
  assert.deepEqual(judgePath(scoped, 'src/a.ts'), { allowed: true });
  assert.deepEqual(judgePath(scoped, 'docs/x.md'), { allowed: false, reason: 'not-included' });
  assert.deepEqual(judgePath(scoped, 'src/secret.ts'), { allowed: false, reason: 'excluded' });
  assert.deepEqual(judgePath(scoped, 'src/bundle.min.js'), { allowed: false, reason: 'excluded' });
  const excludeOnly = { exclude: ['*.json'] };
  assert.equal(scopeAllows(excludeOnly, 'src/a.ts'), true);
  assert.equal(scopeAllows(excludeOnly, 'a.json'), false);
  assert.equal(hasScope(undefined), false);
  assert.equal(hasScope({}), false);
  assert.equal(hasScope(scoped), true);
});

test('detect: reports only out-of-scope paths, deduped + sorted, with reasons', () => {
  const scoped = { include: ['src/**'], exclude: ['src/secret.ts'] };
  const out = detectOutOfScopePaths(scoped, [
    'src/a.ts',
    'docs/x.md',
    'src/secret.ts',
    'docs\\y.md',
    'docs/x.md',
  ]);
  assert.deepEqual(out, [
    { path: 'docs/x.md', reason: 'not-included' },
    { path: 'docs/y.md', reason: 'not-included' },
    { path: 'src/secret.ts', reason: 'excluded' },
  ]);
});

// ---------------------------------------------------------------- jail

test('jail: .. escape denied; in-root and not-yet-existing paths resolve', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-scope-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  assert.equal(resolveScopedRel(root, 'src/a.ts'), 'src/a.ts');
  assert.equal(resolveScopedRel(root, 'new/deep/file.ts'), 'new/deep/file.ts');
  assert.throws(
    () => resolveScopedRel(root, '../outside.ts'),
    (e: unknown) => e instanceof ScopeLockDeniedError && (e as ScopeLockDeniedError).reason === 'escape',
  );
  const scope = { include: ['src/**'] };
  assert.equal(checkScopedWrite(scope, root, 'src/new.ts'), 'src/new.ts');
  assert.throws(
    () => checkScopedWrite(scope, root, 'docs/x.md'),
    (e: unknown) => (e as ScopeLockDeniedError).reason === 'not-included',
  );
});

test('jail: a symlink inside the root pointing outside is judged by its real target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-scope-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-scope-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'src', 'link'), 'dir');
  // The path is lexically inside the workspace but resolves outside.
  assert.throws(
    () => resolveScopedRel(root, 'src/link/evil.ts'),
    (e: unknown) => (e as ScopeLockDeniedError).reason === 'escape',
  );
});

// -------------------------------------------------------------- presets

test('presets: every preset is valid glob input', () => {
  assert.ok(SCOPE_PRESETS.length >= 4);
  for (const p of SCOPE_PRESETS) {
    const v = validateScopeInput({ include: p.include, exclude: p.exclude });
    assert.equal(v.error, undefined, `preset ${p.id} must validate`);
  }
});
