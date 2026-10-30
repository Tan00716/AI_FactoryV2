/**
 * @ai-factory/httpclient — strict substitution tests (round-7 R7-#9, dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnresolvedVars, substituteVarsStrict, substituteVarsStrictDeep, HttpClientError } from '../src/index.js';

test('strict substitution passes clean text and fails naming the missing var', () => {
  assert.equal(substituteVarsStrict('{{a}}/{{b}}', { a: 'x', b: 'y' }), 'x/y');
  assert.throws(() => substituteVarsStrict('{{a}}/{{missing}}', { a: 'x' }), (e: unknown) => {
    assert.equal((e as HttpClientError).code, 'unresolved-variable');
    assert.match((e as Error).message, /\{\{missing\}\}/);
    return true;
  });
});

test('findUnresolvedVars dedupes and strict-deep substitutes object leaves', () => {
  assert.deepEqual(findUnresolvedVars('{{a}} {{a}} {{b}}', { a: '1' }), ['b']);
  const out = substituteVarsStrictDeep({ q: '{{base}}/x', n: 3, arr: ['{{base}}'] }, { base: 'http://h' });
  assert.deepEqual(out, { q: 'http://h/x', n: 3, arr: ['http://h'] });
  assert.throws(() => substituteVarsStrictDeep({ q: '{{nope}}' }, {}), /unresolved variable/);
});
