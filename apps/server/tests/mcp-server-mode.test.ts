/**
 * AI Factory as an MCP server — mcp-serve.ts dispatcher (W-A).
 * Run: node --test dist/tests/mcp-server-mode.test.js (after server build).
 *
 * The dispatcher is exercised with an injected fetchJson (no network)
 * and an injected kill switch:
 *  - initialize / tools/list / tools/call answer the MCP wire when enabled;
 *  - every one of them is refused with -32000 when the server-mode flag is off;
 *  - tool calls forward to the factory HTTP API (paths + methods asserted);
 *  - HTTP failures become isError tool results, never thrown across the wire;
 *  - malformed input → -32700/-32600/-32601 per JSON-RPC.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServeDispatcher, MCP_SERVE_PROTOCOL_VERSION } from '../dist/mcp-serve.js';

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
}

function testDeps(opts: { enabled: boolean; failPaths?: string[] } = { enabled: true }) {
  const seen: SeenCall[] = [];
  const deps = {
    fetchJson: async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
      let body: unknown;
      try {
        body = init.body ? JSON.parse(init.body) : undefined;
      } catch {
        body = init.body;
      }
      seen.push({ url, method: init.method, body });
      const path = new URL(url).pathname;
      if ((opts.failPaths ?? []).includes(path)) {
        return { status: 500, json: async () => ({}), text: async () => 'boom' };
      }
      if (path === '/api/tasks' && init.method === 'POST') {
        return { status: 200, json: async () => ({ id: 't-1', ...(body as object) }), text: async () => '' };
      }
      return { status: 200, json: async () => ({ ok: true, path }), text: async () => '' };
    },
    isEnabled: () => opts.enabled,
    baseUrl: 'http://127.0.0.1:9',
  };
  return { deps, seen };
}

const req = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe('mcp-serve dispatcher', () => {
  it('initialize answers the MCP handshake when enabled', async () => {
    const { deps } = testDeps();
    const { dispatch } = createMcpServeDispatcher(deps);
    const res = await dispatch(req(1, 'initialize', { protocolVersion: '2025-11-25' }));
    assert.equal(res?.id, 1);
    const result = (res?.result ?? {}) as Record<string, unknown>;
    assert.equal(result.protocolVersion, MCP_SERVE_PROTOCOL_VERSION);
    assert.deepEqual((result.serverInfo as Record<string, unknown>).name, 'ai-factory');
  });

  it('tools/list exposes the six factory tools', async () => {
    const { deps } = testDeps();
    const { dispatch, toolNames } = createMcpServeDispatcher(deps);
    const res = await dispatch(req(2, 'tools/list'));
    const tools = ((res?.result ?? {}) as { tools?: Array<{ name: string }> }).tools ?? [];
    assert.deepEqual(
      tools.map((t) => t.name),
      toolNames(),
    );
    assert.deepEqual(toolNames(), [
      'factory_list_tasks',
      'factory_create_task',
      'factory_get_task',
      'factory_knowledge_search',
      'factory_read_file',
      'factory_write_file',
    ]);
  });

  it('tools/call forwards factory_create_task to POST /api/tasks', async () => {
    const { deps, seen } = testDeps();
    const { dispatch } = createMcpServeDispatcher(deps);
    const res = await dispatch(
      req(3, 'tools/call', { name: 'factory_create_task', arguments: { projectId: 'p1', title: 'hello' } }),
    );
    const result = (res?.result ?? {}) as { content?: Array<{ text?: string }> };
    const text = result.content?.[0]?.text ?? '';
    assert.match(text, /t-1/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.ok(seen[0].url.endsWith('/api/tasks'));
    assert.deepEqual((seen[0].body as Record<string, unknown>).title, 'hello');
  });

  it('tools/call validates required args before touching HTTP', async () => {
    const { deps, seen } = testDeps();
    const { dispatch } = createMcpServeDispatcher(deps);
    const res = await dispatch(req(4, 'tools/call', { name: 'factory_create_task', arguments: { title: 'no-project' } }));
    const result = (res?.result ?? {}) as { isError?: boolean };
    assert.equal(result.isError, true);
    assert.equal(seen.length, 0); // no HTTP attempted
  });

  it('HTTP failures become isError results, not thrown errors', async () => {
    const { deps } = testDeps({ enabled: true, failPaths: ['/api/knowledge'] });
    const { dispatch } = createMcpServeDispatcher(deps);
    const res = await dispatch(req(5, 'tools/call', { name: 'factory_knowledge_search', arguments: { q: 'x' } }));
    const result = (res?.result ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /500/);
  });

  it('unknown tool → -32602', async () => {
    const { deps } = testDeps();
    const { dispatch } = createMcpServeDispatcher(deps);
    const res = await dispatch(req(6, 'tools/call', { name: 'nope', arguments: {} }));
    assert.equal((res?.error as { code?: number })?.code, -32602);
  });

  it('kill switch: initialize/tools/list/tools/call all refuse with -32000 when disabled', async () => {
    const { deps } = testDeps({ enabled: false });
    const { dispatch } = createMcpServeDispatcher(deps);
    for (const m of [
      req(11, 'initialize', {}),
      req(12, 'tools/list'),
      req(13, 'tools/call', { name: 'factory_list_tasks', arguments: {} }),
    ]) {
      const res = await dispatch(m);
      assert.equal((res?.error as { code?: number })?.code, -32000, `method ${(m as { method: string }).method}`);
    }
  });

  it('notifications get no response; unknown methods → -32601; garbage → -32700', async () => {
    const { deps } = testDeps();
    const { dispatch } = createMcpServeDispatcher(deps);
    assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const unknown = await dispatch(req(21, 'nope/method'));
    assert.equal((unknown?.error as { code?: number })?.code, -32601);
    const bad = await dispatch('not-an-object');
    assert.equal((bad?.error as { code?: number })?.code, -32700);
    const invalid = await dispatch(req(22, 42 as unknown as string));
    assert.equal((invalid?.error as { code?: number })?.code, -32600);
  });
});
