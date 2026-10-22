/**
 * @ai-factory/httpclient — environment merging + variable substitution tests (dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVariables, substituteVars, validateEnvironments } from '../src/index.js';
import { HttpClientError } from '../src/index.js';

test('explicit variables win over environment vars', () => {
  const merged = mergeVariables({
    environments: { dev: { vars: { baseUrl: 'http://dev', token: 'env-token' } } },
    environment: 'dev',
    variables: { token: 'override' },
  });
  assert.deepEqual(merged, { baseUrl: 'http://dev', token: 'override' });
});

test('unknown environment is fail-closed', () => {
  assert.throws(() => mergeVariables({ environment: 'prod' }), (e: unknown) => {
    assert.equal((e as HttpClientError).code, 'unknown-environment');
    return true;
  });
});

test('substituteVars replaces placeholders and leaves unknowns literal', () => {
  const out = substituteVars('GET {{baseUrl}}/u/{{id}}?x={{missing}}', { baseUrl: 'http://h', id: '7' });
  assert.equal(out, 'GET http://h/u/7?x={{missing}}');
});

test('validateEnvironments accepts a good map and rejects bad shapes', () => {
  const good = validateEnvironments({ dev: { vars: { baseUrl: 'http://h', n: 3 } } });
  assert.deepEqual(good, { dev: { vars: { baseUrl: 'http://h', n: '3' } } });
  assert.throws(() => validateEnvironments({ dev: { vars: { bad: {} } } }), /must be a string\/number\/boolean/);
  assert.throws(() => validateEnvironments({ 'a b': { vars: {} } }), /bad environment name/);
  assert.throws(() => validateEnvironments([]), /must be an object/);
});
