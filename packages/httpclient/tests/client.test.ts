/**
 * @ai-factory/httpclient — sender + assertion tests against a local fixture
 * server (dist). No external network: the fixture binds 127.0.0.1 ephemeral.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  evaluateAssertion,
  lookupJsonPath,
  parseHttpFile,
  sendHttpRequest,
} from '../src/index.js';

function fixture() {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-fixture': 'yes' });
        res.end(JSON.stringify({ user: { name: 'ada', tags: ['a', 'b'] }, count: 3 }));
      } else if (req.url === '/echo' && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'text/plain' });
        res.end(`echo:${body}`);
      } else if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow');
        }, 400);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/json' });
        res.end();
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
  });
  return new Promise<{ server: typeof server; base: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('real GET: assertions pass on good response', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`### probe
GET {{baseUrl}}/json
> status == 200
> status in 2xx
> header content-type contains json
> header x-fixture == yes
> body contains ada
> json-path $.user.name == "ada"
> json-path $.user.tags[1] == "b"
> json-path $.count exists
> max-time-ms 5000
`);
    const result = await sendHttpRequest(spec, { variables: { baseUrl: base } });
    assert.equal(result.status, 200);
    assert.ok(result.durationMs !== undefined && result.durationMs < 5000);
    assert.equal(result.assertions.length, 9);
    assert.ok(result.assertions.every((a) => a.passed), JSON.stringify(result.assertions));
    assert.ok(result.ok);
  } finally {
    server.close();
  }
});

test('assertion failures are reported per-assertion (not thrown)', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`GET ${base}/json
> status == 404
> json-path $.nope exists
> body contains "zzz"
`);
    const result = await sendHttpRequest(spec);
    assert.equal(result.status, 200);
    assert.ok(!result.ok);
    assert.equal(result.assertions.filter((a) => !a.passed).length, 3);
    assert.match(result.assertions[0].detail, /got 200/);
  } finally {
    server.close();
  }
});

test('real POST echoes the substituted body', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`POST ${base}/echo
Content-Type: application/json

{"who": "{{who}}"}

> status == 201
> body contains "echo:"
> body contains "grace"
`);
    const result = await sendHttpRequest(spec, { variables: { who: 'grace' } });
    assert.ok(result.ok, JSON.stringify(result.assertions));
    assert.ok(result.bodyText?.includes('grace'));
  } finally {
    server.close();
  }
});

test('redirects are NOT followed (honest boundary)', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`GET ${base}/redirect\n> status == 302\n`);
    const result = await sendHttpRequest(spec);
    assert.equal(result.status, 302);
    assert.ok(result.ok);
  } finally {
    server.close();
  }
});

test('slow endpoint fails max-time-ms but transport is fine', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`GET ${base}/slow\n> status == 200\n> max-time-ms 100\n`);
    const result = await sendHttpRequest(spec, { defaultTimeoutMs: 5000 });
    assert.equal(result.status, 200);
    assert.ok(!result.ok);
    assert.ok(!result.assertions[1].passed);
    assert.match(result.assertions[1].detail, /took \d+ms/);
  } finally {
    server.close();
  }
});

test('timeout produces an error result, not a throw', async () => {
  const { server, base } = await fixture();
  try {
    const [spec] = parseHttpFile(`GET ${base}/slow\n`);
    const result = await sendHttpRequest(spec, { defaultTimeoutMs: 150 });
    assert.ok(!result.ok);
    assert.match(result.error ?? '', /timed out/);
    assert.equal(result.assertions.length, 0);
  } finally {
    server.close();
  }
});

test('connection refused produces an error result', async () => {
  const [spec] = parseHttpFile('GET http://127.0.0.1:1/unreachable\n');
  const result = await sendHttpRequest(spec, { defaultTimeoutMs: 2000 });
  assert.ok(!result.ok);
  assert.ok(result.error);
});

test('lookupJsonPath handles $ and nested segments', () => {
  const root = { a: { b: [{ c: 1 }] } };
  assert.deepEqual(lookupJsonPath(root, '$'), { found: true, value: root });
  assert.deepEqual(lookupJsonPath(root, '$.a.b[0].c'), { found: true, value: 1 });
  assert.deepEqual(lookupJsonPath(root, '$.a.missing'), { found: false });
  assert.deepEqual(lookupJsonPath(root, '$.a.b[9]'), { found: false });
  assert.deepEqual(lookupJsonPath(root, 'nope'), { found: false });
});

test('evaluateAssertion unit paths', () => {
  const base = { status: 201, headers: { 'x-a': 'hello world' }, bodyText: 'abc', durationMs: 42 };
  assert.ok(evaluateAssertion({ type: 'status', op: 'eq', expected: 201 }, base).passed);
  assert.ok(evaluateAssertion({ type: 'status-class', expected: '2xx' }, base).passed);
  assert.ok(!evaluateAssertion({ type: 'status-class', expected: '2xx' }, { ...base, status: 404 }).passed);
  assert.ok(evaluateAssertion({ type: 'header', name: 'x-a', op: 'contains', expected: 'world' }, base).passed);
  assert.ok(!evaluateAssertion({ type: 'header', name: 'x-missing', op: 'eq', expected: 'x' }, base).passed);
  assert.ok(evaluateAssertion({ type: 'max-time-ms', ms: 100 }, base).passed);
  const json = evaluateAssertion({ type: 'json-path', path: '$.a', op: 'exists' }, { ...base, bodyJson: { a: 1 } });
  assert.ok(json.passed);
  const notJson = evaluateAssertion({ type: 'json-path', path: '$.a', op: 'exists' }, base);
  assert.ok(!notJson.passed);
});
