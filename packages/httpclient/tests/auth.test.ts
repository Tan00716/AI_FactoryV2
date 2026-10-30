/**
 * @ai-factory/httpclient — auth application + redaction tests (dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAuth, redactHeaders, HttpClientError } from '../src/index.js';

test('bearer applies Authorization and never mutates the input map', () => {
  const input = { 'Content-Type': 'application/json' };
  const out = applyAuth(input, { kind: 'bearer' }, 'tok-123');
  assert.equal(out['Authorization'], 'Bearer tok-123');
  assert.equal('Authorization' in input, false);
});

test('basic encodes username:secret and bearer without secret fails closed', () => {
  const out = applyAuth({}, { kind: 'basic', username: 'alice' }, 'pw');
  assert.equal(out['Authorization'], `Basic ${Buffer.from('alice:pw').toString('base64')}`);
  assert.throws(() => applyAuth({}, { kind: 'bearer' }, null), (e: unknown) => (e as HttpClientError).code === 'auth-no-secret');
  assert.throws(() => applyAuth({}, { kind: 'basic' }, 'pw'), (e: unknown) => (e as HttpClientError).code === 'auth-no-username');
});

test('apikey uses the configured header name, default X-Api-Key', () => {
  assert.equal(applyAuth({}, { kind: 'apikey' }, 'k')['X-Api-Key'], 'k');
  assert.equal(applyAuth({}, { kind: 'apikey', headerName: 'X-Custom' }, 'k')['X-Custom'], 'k');
});

test('oauth2 is a placeholder: apply fails closed, never fakes a token', () => {
  assert.throws(() => applyAuth({}, { kind: 'oauth2' }, 'anything'), (e: unknown) => (e as HttpClientError).code === 'oauth2-placeholder');
});

test('redactHeaders redacts Authorization and api-key headers only', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'application/json' }, ['X-Api-Key']);
  assert.deepEqual(out, { Authorization: '<redacted>', 'X-Api-Key': '<redacted>', Accept: 'application/json' });
});
