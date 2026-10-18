/**
 * AI Factory as an MCP server (W-A — "MCP Server 模式", cf. `codex mcp-server`).
 *
 * Run: `node dist/mcp-serve.js` (stdio). External agents (Claude Code,
 * Codex, …) configure it as a stdio MCP server:
 *
 *   { "command": ["node", "/path/to/ai-factory/apps/server/dist/mcp-serve.js"],
 *     "env": { "PORT": "3100", "AI_FACTORY_TOKEN": "<api token>" } }
 *
 * Design (no duplicated business logic): this process is a thin
 * MCP→HTTP bridge. Every tool call is forwarded to the local AI
 * Factory HTTP server (http://127.0.0.1:${PORT ?? 3100}), so all
 * validation, auth and audit live in exactly one place — the server's
 * route layer. The bridge adds:
 *
 *  - the MCP server-mode kill switch (mcp-server-mode.ts): when
 *    disabled, initialize/tools/list/tools/call are refused with a
 *    clear JSON-RPC error instead of silently half-working;
 *  - JSON-RPC 2.0 framing over stdio (line-delimited, like the
 *    official SDK's stdio transport);
 *  - tool results packed as MCP `content` blocks; HTTP failures
 *    become `isError` tool results (never thrown across the wire).
 *
 * Exposed tools (all read/write through the factory's own API):
 *  - factory_list_tasks   {projectId?}            GET /api/tasks
 *  - factory_create_task   {projectId,title,…}     POST /api/tasks
 *  - factory_get_task      {taskId}                GET /api/tasks/:id
 *  - factory_knowledge_search {q}                  GET /api/knowledge?q=
 *  - factory_read_file     {path}                  GET /api/file?path=
 *  - factory_write_file    {path,content}          POST /api/file
 *
 * Env:
 *  - PORT (default 3100) — the local factory server's port.
 *  - AI_FACTORY_TOKEN — Bearer token when the server requires auth.
 *  - AI_FACTORY_DATA_DIR — the server's data dir (so the kill-switch
 *    file resolves identically when this bridge is spawned with a
 *    different cwd by an external agent).
 *  - AI_FACTORY_MCP_SERVER_MODE_FILE — explicit override for the
 *    kill-switch file.
 *
 * Honest boundaries:
 *  - This bridge performs NO auth itself; it forwards the operator's
 *    token to the factory server, which enforces auth. Without a
 *    token on an auth-required server, calls fail with the server's
 *    401 — surfaced as isError, not hidden.
 *  - Tool input is validated twice: JSON-schema shape here (cheap,
 *    early) and for real by the server routes.
 */
import { readServerModeFlag } from './mcp-server-mode';

export const MCP_SERVE_PROTOCOL_VERSION = '2025-11-25';

export interface McpServeFetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface McpServeFetchResult {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface McpServeDeps {
  /** HTTP client (global fetch by default; injectable for tests) */
  fetchJson: (url: string, init: McpServeFetchInit) => Promise<McpServeFetchResult>;
  /** kill-switch state */
  isEnabled: () => boolean;
  /** e.g. http://127.0.0.1:3100 */
  baseUrl: string;
  /** Bearer token for the factory server, when auth is required */
  authToken?: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createMcpServeDispatcher(deps: McpServeDeps) {
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(deps.authToken ? { authorization: `Bearer ${deps.authToken}` } : {}),
  });

  async function api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const res = await deps.fetchJson(`${deps.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: headers(),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status >= 200 && res.status < 300) return res.json();
    const text = await res.text().catch(() => '');
    throw new Error(`factory API ${res.status}: ${text.slice(0, 500) || '(empty body)'}`);
  }

  const tools: ToolDef[] = [
    {
      name: 'factory_list_tasks',
      description: 'List tasks (optionally filtered by projectId).',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project id filter (optional)' } },
      },
      run: async (args) => {
        const q = typeof args.projectId === 'string' && args.projectId ? `?projectId=${encodeURIComponent(args.projectId)}` : '';
        return api(`/api/tasks${q}`);
      },
    },
    {
      name: 'factory_create_task',
      description: 'Create a task. authorizationStatus: DRAFT | WAITING_HUMAN_DISPATCH | AUTHORIZED (default AUTHORIZED).',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'title'],
        properties: {
          projectId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          authorizationStatus: { type: 'string', enum: ['DRAFT', 'WAITING_HUMAN_DISPATCH', 'AUTHORIZED'] },
        },
      },
      run: async (args) => {
        if (typeof args.projectId !== 'string' || !args.projectId) throw new Error('projectId is required');
        if (typeof args.title !== 'string' || !args.title) throw new Error('title is required');
        return api('/api/tasks', {
          method: 'POST',
          body: {
            projectId: args.projectId,
            title: args.title,
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
            ...(typeof args.authorizationStatus === 'string' ? { authorizationStatus: args.authorizationStatus } : {}),
          },
        });
      },
    },
    {
      name: 'factory_get_task',
      description: 'Get one task by id.',
      inputSchema: {
        type: 'object',
        required: ['taskId'],
        properties: { taskId: { type: 'string' } },
      },
      run: async (args) => {
        if (typeof args.taskId !== 'string' || !args.taskId) throw new Error('taskId is required');
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}`);
      },
    },
    {
      name: 'factory_knowledge_search',
      description: 'Search the knowledge base.',
      inputSchema: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string', description: 'Search query' } },
      },
      run: async (args) => {
        if (typeof args.q !== 'string' || !args.q) throw new Error('q is required');
        return api(`/api/knowledge?q=${encodeURIComponent(args.q)}`);
      },
    },
    {
      name: 'factory_read_file',
      description: 'Read a text file from the workspace (path relative to workspace root).',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      run: async (args) => {
        if (typeof args.path !== 'string' || !args.path) throw new Error('path is required');
        return api(`/api/file?path=${encodeURIComponent(args.path)}`);
      },
    },
    {
      name: 'factory_write_file',
      description: 'Write a text file to the workspace (path relative to workspace root).',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      run: async (args) => {
        if (typeof args.path !== 'string' || !args.path) throw new Error('path is required');
        if (typeof args.content !== 'string') throw new Error('content is required');
        return api('/api/file', { method: 'POST', body: { path: args.path, content: args.content, actor: 'mcp-server-mode' } });
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  function disabledError(id: unknown): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32000,
        message:
          'AI Factory MCP server mode is disabled — enable it in the desktop McpPanel (Server 模式) or via POST /api/mcp/server-mode',
      },
    };
  }

  /** Dispatch one parsed JSON-RPC message; returns the response object, or null for notifications. */
  async function dispatch(msg: unknown): Promise<Record<string, unknown> | null> {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: expected a JSON-RPC object' } };
    }
    const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = m.id ?? null;
    const isNotification = m.id === undefined;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }

    if (m.method === 'notifications/initialized') return null; // ack, no response

    if (m.method === 'initialize') {
      if (!deps.isEnabled()) return disabledError(id);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_SERVE_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-factory', version: '0.1.0' },
        },
      };
    }

    if (m.method === 'tools/list') {
      if (!deps.isEnabled()) return disabledError(id);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };
    }

    if (m.method === 'tools/call') {
      if (!deps.isEnabled()) return disabledError(id);
      const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool '${String(params.name)}'` } };
      }
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const data = await tool.run(args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? '');
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: `tool '${tool.name}' failed: ${message}` }] },
        };
      }
    }

    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }

  return { dispatch, toolNames: () => tools.map((t) => t.name) };
}

export type McpServeDispatcher = ReturnType<typeof createMcpServeDispatcher>;

/* ------------------------------------------------------------ stdio -- */

function defaultDeps(): McpServeDeps {
  const port = process.env.PORT ?? '3100';
  return {
    fetchJson: async (url, init) => {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return {
        status: res.status,
        json: () => res.json() as Promise<unknown>,
        text: () => res.text(),
      };
    },
    isEnabled: () => readServerModeFlag().enabled,
    baseUrl: `http://127.0.0.1:${port}`,
    ...(process.env.AI_FACTORY_TOKEN ? { authToken: process.env.AI_FACTORY_TOKEN } : {}),
  };
}

async function main(): Promise<void> {
  const { dispatch } = createMcpServeDispatcher(defaultDeps());
  let buf = '';
  process.stdin.setEncoding('utf8');
  const write = (obj: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      void dispatch(msg)
        .then((res) => {
          if (res) write(res);
        })
        .catch((err) => {
          const m = msg as { id?: unknown };
          write({
            jsonrpc: '2.0',
            id: (m as { id?: unknown }).id ?? null,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err ?? '') },
          });
        });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Only run the stdio loop when executed directly (importable for tests).
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('mcp-serve.js');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`mcp-serve: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
