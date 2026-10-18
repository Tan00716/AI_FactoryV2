/**
 * Tests for StreamableMcpConnector — stateless model (MCP 2026-07-28).
 * Run: node --test dist/tests/streamable-connector.test.js   (after tsc -p tsconfig.json)
 *
 * A fake MCP server (node:http, 127.0.0.1 ephemeral port) speaks the
 * stateless Streamable HTTP wire: POST /mcp answers tools/list,
 * resources/list, prompts/list and tools/call directly — NO initialize
 * handshake, NO Mcp-Session-Id. The test asserts the client never
 * sends a session id and never calls initialize.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  StreamableMcpConnector,
  McpConnectionError,
  type McpServer,
} from '../src/index';

function testServerDef(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: 'fake-http',
    version: '1.0.0',
    provider: 'test',
    transport: 'http',
    tools: [],
    resources: [],
    scopes: [],
    permissions: [],
    trustLevel: 'UNKNOWN',
    approvalPolicy: 'BLOCKED',
    registeredAt: Date.now(),
    ...overrides,
  };
}

interface FakeHttp {
  base: string;
  listCalls: number;
  sawSessionId: boolean;
  sawInitialize: boolean;
  sseMode: boolean;
  close(): Promise<void>;
}

async function startFakeHttp(): Promise<FakeHttp> {
  const state: FakeHttp = { base: '', listCalls: 0, sawSessionId: false, sawInitialize: false, sseMode: false, close: async () => {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/mcp' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number | string; method?: string; params?: Record<string, unknown> };
        if (req.headers['mcp-session-id']) state.sawSessionId = true;
        if (msg.method === 'initialize') state.sawInitialize = true;
        if (msg.method === 'initialize') {
          // Stateless server: initialize is not part of the protocol.
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
          return;
        }
        const answer = (result: unknown) => {
          if (state.sseMode) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          }
        };
        if (msg.method === 'tools/list') {
          state.listCalls++;
          answer({ tools: [{ name: 'add', description: 'add two numbers' }] });
        } else if (msg.method === 'resources/list') {
          state.listCalls++;
          answer({ resources: [{ uri: 'file:///notes.md', name: 'notes' }] });
        } else if (msg.method === 'prompts/list') {
          state.listCalls++;
          answer({ prompts: [{ name: 'summarize' }] });
        } else if (msg.method === 'tools/call') {
          const p = (msg.params ?? {}) as { name?: string; arguments?: { a?: number; b?: number } };
          const a = p.arguments?.a ?? 0;
          const b = p.arguments?.b ?? 0;
          answer({ content: [{ type: 'text', text: String(a + b) }] });
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }),
          );
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  state.base = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

describe('StreamableMcpConnector (stateless)', () => {
  let fake: FakeHttp;
  before(async () => {
    fake = await startFakeHttp();
  });
  after(async () => {
    await fake.close();
  });

  it('launch → discoverCapabilities → callTool with no handshake and no session', async () => {
    const c = new StreamableMcpConnector({ url: `${fake.base}/mcp` });
    const server = testServerDef();
    await c.launch(server); // no network I/O — URL usability only
    const caps = await c.discoverCapabilities(server);
    assert.deepEqual(caps.tools.map((t) => t.name), ['add']);
    assert.deepEqual(caps.resources.map((r) => r.uri), ['file:///notes.md']);
    assert.deepEqual(caps.prompts.map((p) => p.name), ['summarize']);
    const result = await c.callTool(server, 'add', { a: 20, b: 22 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.content, [{ type: 'text', text: '42' }]);
    assert.equal(fake.sawInitialize, false);
    assert.equal(fake.sawSessionId, false);
    await c.close(server);
  });

  it('discoverCapabilities caches for ttlMs and re-lists after expiry', async () => {
    const c = new StreamableMcpConnector({ url: `${fake.base}/mcp` });
    const server = testServerDef();
    await c.launch(server);
    const before = fake.listCalls;
    await c.discoverCapabilities(server, { ttlMs: 60_000 });
    const afterFirst = fake.listCalls;
    assert.equal(afterFirst - before, 3); // tools + resources + prompts
    await c.discoverCapabilities(server, { ttlMs: 60_000 });
    assert.equal(fake.listCalls, afterFirst); // served from cache — no new calls
    await c.discoverCapabilities(server); // no ttl → always re-lists
    assert.equal(fake.listCalls, afterFirst + 3);
    await c.close(server);
  });

  it('parses an SSE-stream response body', async () => {
    fake.sseMode = true;
    try {
      const c = new StreamableMcpConnector({ url: `${fake.base}/mcp` });
      const server = testServerDef();
      await c.launch(server);
      const tools = await c.listTools(server);
      assert.deepEqual(tools.map((t) => t.name), ['add']);
      await c.close(server);
    } finally {
      fake.sseMode = false;
    }
  });

  it('surfaces HTTP 401 as a protocol error', async () => {
    const denied = http.createServer((_req, res) => {
      res.writeHead(401).end();
    });
    await new Promise<void>((r) => denied.listen(0, '127.0.0.1', r));
    const addr = denied.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    try {
      const c = new StreamableMcpConnector({ url: `http://127.0.0.1:${addr.port}/mcp` });
      const server = testServerDef();
      await c.launch(server);
      await assert.rejects(() => c.listTools(server), /rejected with HTTP 401/);
      await c.close(server);
    } finally {
      await new Promise<void>((r) => denied.close(() => r()));
    }
  });

  it('launch refuses non-http transports and missing URLs', async () => {
    const c = new StreamableMcpConnector({ url: `${fake.base}/mcp` });
    await assert.rejects(() => c.launch(testServerDef({ transport: 'stdio' })), /only supports http/);
    const c2 = new StreamableMcpConnector();
    await assert.rejects(() => c2.launch(testServerDef()), /has no HTTP URL/);
  });

  it('launch refuses credential-bearing plain HTTP to non-loopback hosts', async () => {
    const c = new StreamableMcpConnector({
      url: 'http://example.com/mcp',
      headers: { authorization: 'Bearer x' },
    });
    await assert.rejects(() => c.launch(testServerDef()), McpConnectionError);
  });
});
