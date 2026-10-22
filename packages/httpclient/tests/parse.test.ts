/**
 * @ai-factory/httpclient — .http parser tests (dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpFile } from '../src/index.js';
import { HttpClientError } from '../src/index.js';

test('parses a single request with headers, body and assertions', () => {
  const reqs = parseHttpFile(`### Create user
POST {{baseUrl}}/users
Content-Type: application/json
Authorization: Bearer {{token}}

{"name": "a", "tags": ["x"]}

> status == 201
> header content-type contains json
> body contains "a"
> json-path $.name == "a"
> max-time-ms 1000
`);
  assert.equal(reqs.length, 1);
  const r = reqs[0];
  assert.equal(r.name, 'Create user');
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '{{baseUrl}}/users');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['authorization'], 'Bearer {{token}}');
  assert.ok(r.body?.includes('"name": "a"'));
  assert.equal(r.assertions.length, 5);
  assert.deepEqual(r.assertions[0], { type: 'status', op: 'eq', expected: 201 });
  assert.deepEqual(r.assertions[1], { type: 'header', name: 'content-type', op: 'contains', expected: 'json' });
  assert.deepEqual(r.assertions[2], { type: 'body-contains', text: 'a' });
  assert.deepEqual(r.assertions[3], { type: 'json-path', path: '$.name', op: 'eq', expected: 'a' });
  assert.deepEqual(r.assertions[4], { type: 'max-time-ms', ms: 1000 });
});

test('parses multiple requests separated by ###', () => {
  const reqs = parseHttpFile(`GET http://a/1
> status in 2xx

### second
DELETE http://a/2
> status == 204
`);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].name, '');
  assert.equal(reqs[1].name, 'second');
  assert.equal(reqs[0].method, 'GET');
  assert.equal(reqs[1].method, 'DELETE');
  assert.deepEqual(reqs[0].assertions[0], { type: 'status-class', expected: '2xx' });
});

test('supports @timeout-ms directive', () => {
  const reqs = parseHttpFile(`GET http://a/
@timeout-ms 2500
> status == 200
`);
  assert.equal(reqs[0].timeoutMs, 2500);
  assert.equal(reqs[0].assertions.length, 1);
});

test('skips # and // comments outside the body', () => {
  const reqs = parseHttpFile(`# lead comment
// another
### named
GET http://a/
> status == 200
`);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].name, 'named');
});

test('rejects bad syntax with line numbers', () => {
  assert.throws(() => parseHttpFile('FROBNICATE\n'), (e: unknown) => {
    assert.ok(e instanceof HttpClientError);
    assert.match((e as Error).message, /line 1/);
    return true;
  });
  assert.throws(() => parseHttpFile('GET http://a/\n> nonsense here\n'), (e: unknown) => {
    assert.ok(e instanceof HttpClientError);
    assert.equal((e as HttpClientError).code, 'parse-error');
    return true;
  });
  assert.throws(() => parseHttpFile('   \n'), (e: unknown) => {
    assert.equal((e as HttpClientError).code, 'empty');
    return true;
  });
});

test('caps the number of requests', () => {
  const many = Array.from({ length: 101 }, (_, i) => `### r${i}\nGET http://a/${i}\n`).join('\n');
  assert.throws(() => parseHttpFile(many), (e: unknown) => {
    assert.equal((e as HttpClientError).code, 'too-many-requests');
    return true;
  });
});
