/**
 * @ai-factory/mcp — remote MCP client over Streamable HTTP, stateless
 * model (MCP spec 2026-07-28 revision).
 *
 * Wire: every JSON-RPC message is a POST to the single endpoint URL with
 * `Accept: application/json, text/event-stream`. The server answers with
 * either one JSON-RPC message or an SSE stream of frames; both shapes
 * are accepted and correlated by request id.
 *
 * Stateless means exactly that:
 *  - NO `initialize` handshake — capability discovery is a direct
 *    `tools/list` / `resources/list` / `prompts/list`. (The stateful
 *    initialize flow lives in handshake.ts and is stdio-only now.)
 *  - NO `Mcp-Session-Id` — nothing is sent, nothing is stored, there
 *    is no 404-session-expired retry path and no DELETE on close.
 *  - discoverCapabilities() caches the three lists for `ttlMs`
 *    (default: no cache — pass a positive ttlMs to reuse).
 *
 * Zero external dependencies — node:http / node:https only.
 *
 * Honest boundaries:
 *  - Only 'http' servers are accepted by launch(); anything else throws.
 *  - launch() validates the URL and the §34.3 policy but performs no
 *    network I/O: reachability is proven by the first list call, and
 *    the graded-health 'launch' level for HTTP is therefore "URL
 *    usable", stated plainly (unlike stdio, there is no process to
 *    spawn).
 *  - Redirects are policy-gated (default: not followed).
 *  - Credential-bearing plain-HTTP is refused for non-loopback hosts.
 */
import { McpConnectionError } from './handshake';
import type {
  McpPrompt,
  McpResource,
  McpServer,
  McpTool,
  McpToolCallResult,
  StatelessMcpConnector,
} from './types';
import {
  SseParser,
  applyRedirectPolicy,
  asMcpHttpError,
  assertServerUrlUsable,
  doHttpRequest,
  parseJsonRpcResponse,
  type HttpResponse,
} from './http-transport';

export interface StreamableConnectorOptions {
  /** Streamable HTTP endpoint URL; falls back to server.runtimePolicy.serverUrl */
  url?: string;
  /** extra headers (e.g. Authorization) — supplied by the server layer */
  headers?: Record<string, string>;
  /** per-request timeout in ms (default 10000) */
  requestTimeoutMs?: number;
  /** max bytes for one response (default 4 MiB) */
  maxResponseBytes?: number;
  /** follow HTTP redirects per the §34.3 policy (default false) */
  followRedirects?: boolean;
  /** injectable clock for tests (drives the capability cache TTL) */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 3;

export interface DiscoveredCapabilities {
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export class StreamableMcpConnector implements StatelessMcpConnector {
  private readonly opts: Required<Omit<StreamableConnectorOptions, 'url' | 'headers' | 'now'>> &
    Pick<StreamableConnectorOptions, 'url' | 'headers' | 'now'>;
  private endpointUrl: string | null = null;
  private capsCache: { at: number; ttlMs: number; caps: DiscoveredCapabilities } | null = null;
  private nextId = 1;

  constructor(opts: StreamableConnectorOptions = {}) {
    this.opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_BYTES,
      followRedirects: opts.followRedirects ?? false,
      url: opts.url,
      headers: opts.headers,
      now: opts.now,
    };
  }

  private clockNow(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private resolveUrl(server: McpServer): string {
    const url = this.opts.url ?? server.runtimePolicy?.serverUrl;
    if (!url) {
      throw new McpConnectionError(
        'protocol',
        'launch',
        `mcp: ${server.name}@${server.version} has no HTTP URL (set runtimePolicy.serverUrl or pass url)`,
      );
    }
    return url;
  }

  private hasCredentials(): boolean {
    const h = this.opts.headers ?? {};
    return Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
  }

  async launch(server: McpServer): Promise<void> {
    if (server.transport !== 'http') {
      throw new McpConnectionError(
        'protocol',
        'launch',
        `mcp: StreamableMcpConnector only supports http servers (got ${server.transport})`,
      );
    }
    if (this.endpointUrl) return; // idempotent
    const url = this.resolveUrl(server);
    assertServerUrlUsable(server.runtimePolicy, url, {
      credentialsPresent: this.hasCredentials(),
      server,
      stage: 'launch',
    });
    // No network I/O: for HTTP the "launch" level is URL-usability;
    // reachability is proven by the first list call. Documented, not hidden.
    this.endpointUrl = url;
  }

  private requireEndpoint(server: McpServer): string {
    if (!this.endpointUrl) {
      throw new McpConnectionError('unreachable', 'protocol', `mcp: ${server.name}@${server.version} is not launched`);
    }
    return this.endpointUrl;
  }

  /** POST one JSON-RPC message; follow policy-gated redirects; return the raw response. */
  private async post(server: McpServer, msg: unknown, acceptSse: boolean): Promise<HttpResponse> {
    let url = this.requireEndpoint(server);
    let headers: Record<string, string> = {
      ...(this.opts.headers ?? {}),
      accept: acceptSse ? 'application/json, text/event-stream' : 'application/json',
    };

    let hops = 0;
    for (;;) {
      let res: HttpResponse;
      try {
        res = await doHttpRequest(url, {
          method: 'POST',
          headers,
          jsonBody: msg,
          timeoutMs: this.opts.requestTimeoutMs,
          maxBytes: this.opts.maxResponseBytes,
        });
      } catch (err) {
        throw asMcpHttpError(err, server, 'protocol', `POST ${url}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          throw new McpConnectionError('protocol', 'protocol', 'mcp: too many redirects on POST');
        }
        const next = applyRedirectPolicy(server.runtimePolicy, url, res.headers.location, {
          credentialsPresent: this.hasCredentials(),
          server,
          stage: 'protocol',
        });
        url = next.url;
        if (!next.forwardCredentials) {
          headers = { ...headers };
          for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
        }
        continue;
      }
      return res;
    }
  }

  /**
   * Extract the JSON-RPC response with `id` from a POST response body,
   * which may be a single JSON message or an SSE stream of frames.
   * Returns undefined for empty bodies.
   */
  private extractResponse(
    server: McpServer,
    res: HttpResponse,
    id: number | string,
    what: string,
  ): Record<string, unknown> | undefined {
    const raw = res.body.toString('utf8');
    if (!raw.trim()) return undefined;
    const ctype = res.headers['content-type'] ?? '';
    if (ctype.includes('text/event-stream')) {
      let found: Record<string, unknown> | undefined;
      const parser = new SseParser((e) => {
        if (found || !e.data) return;
        try {
          const msg = parseJsonRpcResponse(e.data, server, 'protocol', what);
          if (msg.id === id) found = msg;
        } catch {
          /* skip malformed frames */
        }
      });
      // Feed the body untrimmed: the terminating blank line is what
      // dispatches the final frame.
      parser.feed(raw);
      if (!found) {
        throw new McpConnectionError(
          'protocol',
          'protocol',
          `mcp: ${server.name}@${server.version} ${what}: no response frame for id ${id} in the SSE stream`,
        );
      }
      return found;
    }
    const msg = parseJsonRpcResponse(raw.trim(), server, 'protocol', what);
    if (msg.id !== id) {
      throw new McpConnectionError(
        'protocol',
        'protocol',
        `mcp: ${server.name}@${server.version} ${what}: response id mismatch (want ${id})`,
      );
    }
    return msg;
  }

  /** Send one request and return its `result`. No sessions, no retries here (the server layer owns retry). */
  private async rpc(
    server: McpServer,
    method: string,
    params: Record<string, unknown>,
    what: string,
    stage: McpConnectionError['stage'],
  ): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post(server, { jsonrpc: '2.0', id, method, params }, true);
    if (res.status === 401 || res.status === 403) {
      throw new McpConnectionError('protocol', stage, `mcp: ${what} rejected with HTTP ${res.status}`);
    }
    if (res.status !== 200) {
      throw new McpConnectionError('protocol', stage, `mcp: ${what} failed with HTTP ${res.status}`);
    }
    const msg = this.extractResponse(server, res, id, what);
    if (!msg) throw new McpConnectionError('protocol', stage, `mcp: ${what}: empty response body`);
    if (msg.error !== undefined && msg.error !== null) {
      const e = (msg.error as Record<string, unknown>) ?? {};
      const message = typeof e.message === 'string' ? e.message : 'unknown JSON-RPC error';
      const code = typeof e.code === 'number' ? e.code : undefined;
      throw Object.assign(
        new McpConnectionError(
          stage === 'execution' ? 'tool' : 'protocol',
          stage,
          `mcp: ${what}: JSON-RPC error${code !== undefined ? ` (${code})` : ''}: ${message}`,
        ),
        { code },
      );
    }
    return (msg as { result?: unknown }).result;
  }

  async discoverCapabilities(server: McpServer, opts?: { ttlMs?: number }): Promise<DiscoveredCapabilities> {
    const ttlMs = opts?.ttlMs ?? 0;
    const now = this.clockNow();
    if (ttlMs > 0 && this.capsCache && now - this.capsCache.at < this.capsCache.ttlMs) {
      return this.capsCache.caps;
    }
    const [tools, resources, prompts] = await Promise.all([
      this.listTools(server),
      this.listResources(server),
      this.listPrompts(server),
    ]);
    const caps = { tools, resources, prompts };
    if (ttlMs > 0) this.capsCache = { at: now, ttlMs, caps };
    return caps;
  }

  async listTools(server: McpServer): Promise<McpTool[]> {
    let raw: unknown;
    try {
      raw = await this.rpc(server, 'tools/list', {}, 'tools/list', 'tools');
    } catch (err) {
      throw asMcpHttpError(err, server, 'tools', 'tools/list');
    }
    const result = asObject(raw, server, 'tools/list result');
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((t, i) => {
      const o = asObject(t, server, `tools/list tool[${i}]`);
      if (typeof o.name !== 'string' || !o.name) {
        throw new McpConnectionError('protocol', 'tools', `mcp: tools/list returned a tool without a name`);
      }
      const tool: McpTool = { name: o.name };
      if (typeof o.description === 'string') tool.description = o.description;
      return tool;
    });
  }

  async listResources(server: McpServer): Promise<McpResource[]> {
    let raw: unknown;
    try {
      raw = await this.rpc(server, 'resources/list', {}, 'resources/list', 'tools');
    } catch (err) {
      throw asMcpHttpError(err, server, 'tools', 'resources/list');
    }
    const result = asObject(raw, server, 'resources/list result');
    const resources = Array.isArray(result.resources) ? result.resources : [];
    return resources
      .map((r) => asObject(r, server, 'resource', true))
      .filter((o) => typeof o.uri === 'string' && o.uri)
      .map((o) => ({
        uri: o.uri as string,
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
      }));
  }

  async listPrompts(server: McpServer): Promise<McpPrompt[]> {
    let raw: unknown;
    try {
      raw = await this.rpc(server, 'prompts/list', {}, 'prompts/list', 'tools');
    } catch (err) {
      throw asMcpHttpError(err, server, 'tools', 'prompts/list');
    }
    const result = asObject(raw, server, 'prompts/list result');
    const prompts = Array.isArray(result.prompts) ? result.prompts : [];
    return prompts
      .map((p) => asObject(p, server, 'prompt', true))
      .filter((o) => typeof o.name === 'string' && o.name)
      .map((o) => ({
        name: o.name as string,
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
      }));
  }

  async callTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    let raw: unknown;
    try {
      raw = await this.rpc(server, 'tools/call', { name: tool, arguments: args }, `tools/call ${tool}`, 'execution');
    } catch (err) {
      throw asMcpHttpError(err, server, 'execution', `tools/call ${tool}`);
    }
    const result = asObject(raw, server, 'tools/call result');
    if (result.isError === true) {
      const text = extractText(result.content);
      return { ok: false, isError: true, errorText: text ?? 'tool returned isError', content: result.content };
    }
    return { ok: true, content: result.content };
  }

  async close(_server: McpServer): Promise<void> {
    // Stateless: nothing server-side to tear down. Drop local state only.
    this.endpointUrl = null;
    this.capsCache = null;
  }
}

function asObject(value: unknown, server: McpServer, what: string, lenient = false): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (lenient) return {};
  throw new McpConnectionError('protocol', 'protocol', `mcp: ${server.name}@${server.version}: expected ${what} to be an object`);
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.length ? parts.join('\n') : undefined;
}
