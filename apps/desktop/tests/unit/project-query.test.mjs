/**
 * Multi-project window binding unit tests.
 * node:test + node:assert/strict. Run: node --test apps/desktop/tests/unit/project-query.test.mjs
 * (also runs as phase 1 of `npm run test:desktop`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { initialProjectId, DEFAULT_PROJECT_ID } = await import('../../src/utils/project-query.ts');

test('no project param falls back to default', () => {
  assert.equal(initialProjectId(''), DEFAULT_PROJECT_ID);
  assert.equal(initialProjectId('?apiPort=3100'), DEFAULT_PROJECT_ID);
});

test('valid project param is honored', () => {
  assert.equal(initialProjectId('?project=proj-abc_123'), 'proj-abc_123');
  assert.equal(initialProjectId('?apiPort=3100&project=proj-b'), 'proj-b');
});

test('custom fallback is used when param absent', () => {
  assert.equal(initialProjectId('', 'proj-x'), 'proj-x');
});

test('junk project param fails closed to fallback', () => {
  assert.equal(initialProjectId('?project='), DEFAULT_PROJECT_ID);
  assert.equal(initialProjectId('?project=../../etc'), DEFAULT_PROJECT_ID);
  assert.equal(initialProjectId('?project=<script>'), DEFAULT_PROJECT_ID);
  assert.equal(initialProjectId('?project=' + 'a'.repeat(65)), DEFAULT_PROJECT_ID);
  assert.equal(initialProjectId('?project=has space'), DEFAULT_PROJECT_ID);
});

test('whitespace around a valid id is trimmed', () => {
  assert.equal(initialProjectId('?project=%20proj-a%20'), 'proj-a');
});

test('default project id matches the app hard default', () => {
  assert.equal(DEFAULT_PROJECT_ID, 'proj-myapp');
});
