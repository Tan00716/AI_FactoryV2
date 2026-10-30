/**
 * @ai-factory/httpclient — GraphQL builder + sender tests (dist).
 * A local HTTP server stands in for a GraphQL endpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildGraphqlBody, sendGraphqlRequest } from '../src/index.js';

test('buildGraphqlBody validates and shapes the body', () => {
  const body = JSON.parse(buildGraphqlBody({ endpoint: 'http://h/graphql', query: '{ user { id } }', variables: { id: 7 } }));
  assert.equal(body.query, '{ user { id } }');
  assert.deepEqual(body.variables, { id: 7 });
  assert.throws(() => buildGraphqlBody({ endpoint: 'http://h/graphql', query: '  ' }), /query is required/);
  assert.throws(() => buildGraphqlBody({ endpoint: 'http://h/graphql', query: '{ x }', variables: 'nope' as never }), /variables must be an object/);
});

test('sendGraphqlRequest posts JSON and surfaces graphql errors', async () => {
  const seen: Array<{ auth?: string; body: unknown }> = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ auth: req.headers['authorization'], body });
      if (body.query.includes('boom')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'field boom does not exist' }] }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { user: { id: 7 } } }));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const ok = await sendGraphqlRequest({ endpoint: `http://127.0.0.1:${port}/graphql`, query: '{ user { id } }' });
    assert.equal(ok.status, 200);
    assert.equal((ok.bodyJson as { data: { user: { id: number } } }).data.user.id, 7);
    assert.equal(ok.graphqlErrors, undefined);
    const bad = await sendGraphqlRequest(
      { endpoint: `http://127.0.0.1:${port}/graphql`, query: '{ boom }' },
      { Authorization: 'Bearer tok' },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.graphqlErrors?.[0].message, 'field boom does not exist');
    assert.equal(seen[1].auth, 'Bearer tok');
  } finally {
    srv.close();
  }
});
