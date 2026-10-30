/**
 * @ai-factory/httpclient — collections / auth profiles / environments tests (dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactApiEnvironment,
  stripAuthHeaders,
  validateApiEnvironment,
  validateAuthProfile,
  validateCollection,
} from '../src/index.js';

test('collection validation accepts a good collection and rejects inline Authorization', () => {
  const good = validateCollection({
    id: 'c1',
    name: 'demo',
    requests: [{ id: 'r1', name: 'health', method: 'GET', url: '{{baseUrl}}/api/health', headers: {} }],
  });
  assert.equal(good.requests.length, 1);
  assert.throws(
    () =>
      validateCollection({
        id: 'c1',
        name: 'demo',
        requests: [{ id: 'r1', name: 'x', method: 'GET', url: 'http://h', headers: { Authorization: 'Bearer secret' } }],
      }),
    /must not carry an inline Authorization header/,
  );
});

test('collection validation rejects bad ids, methods, duplicate requests', () => {
  assert.throws(() => validateCollection({ id: 'bad id', name: 'x', requests: [] }), /collection id/);
  assert.throws(
    () => validateCollection({ id: 'c1', name: 'x', requests: [{ id: 'r1', name: 'x', method: 'FETCH', url: 'http://h', headers: {} }] }),
    /bad request method/,
  );
  assert.throws(
    () =>
      validateCollection({
        id: 'c1',
        name: 'x',
        requests: [
          { id: 'r1', name: 'a', method: 'GET', url: 'http://h', headers: {} },
          { id: 'r1', name: 'b', method: 'GET', url: 'http://h', headers: {} },
        ],
      }),
    /duplicate request id/,
  );
});

test('auth profile validation: basic needs username, apikey headerName validated', () => {
  const basic = validateAuthProfile({ id: 'p1', name: 'svc', kind: 'basic', username: 'alice' });
  assert.equal(basic.username, 'alice');
  assert.throws(() => validateAuthProfile({ id: 'p1', name: 'svc', kind: 'basic' }), /requires a username/);
  assert.throws(() => validateAuthProfile({ id: 'p1', name: 'svc', kind: 'apikey', headerName: 'bad header' }), /bad apikey headerName/);
  const oauth = validateAuthProfile({ id: 'p2', name: 'oauth', kind: 'oauth2' });
  assert.equal(oauth.kind, 'oauth2');
});

test('environment validation and redaction: secret values become <redacted>', () => {
  const env = validateApiEnvironment({ name: 'dev', vars: { baseUrl: 'http://h', token: 's3cr3t' }, secretNames: ['token'] });
  const redacted = redactApiEnvironment(env);
  assert.equal(redacted.vars['token'], '<redacted>');
  assert.equal(redacted.vars['baseUrl'], 'http://h');
  assert.deepEqual(redacted.secretNames, ['token']);
  assert.throws(() => validateApiEnvironment({ name: 'dev', vars: {}, secretNames: ['a', 'a'] }), /duplicate secret name/);
});

test('stripAuthHeaders drops Authorization and api-key headers only', () => {
  const out = stripAuthHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', 'Content-Type': 'application/json' }, ['X-Api-Key']);
  assert.deepEqual(out, { 'Content-Type': 'application/json' });
});
