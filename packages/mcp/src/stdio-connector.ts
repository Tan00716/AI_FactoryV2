/**
 * @ai-factory/mcp — real stdio transport (JSON-RPC 2.0 over a child process).
 *
 * Batch 37 closes the long-standing KNOWN_LIMITATIONS entry
 * "MCP Registry 有实现，但未接入真实 MCP 服务": this is a genuine
 * McpConnector that spawns a real MCP server process and speaks the MCP
 * wire protocol to it. Zero external dependencies — only node:child_process.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout,
 * matching the official TypeScript SDK's stdio transport. stderr is
 * captured (bounded) purely for failure context and never parsed as
 * protocol.
 *
 * Honest boundaries:
 *  - Only stdio servers are supported (launch() rejects anything else).
 *  - Server-to-client requests (e.g. roots/list, sampling) are answered
 *    with JSON-RPC Method-not-found (-32601); we are not a sampling host.
 *  - Server notifications (e.g. notifications/message logging) are read
 *    and discarded so they can never be mistaken for a response.
 *  - initialize() proposes the client's first protocol version and
 *    ACCEPTS the server's answer only when it is one of the versions the
 *    caller listed; otherwise it throws a protocol McpConnectionError
 *    instead of pretending the session is usable.
 *  - Env passed to the child defaults to { PATH } + opts.env; the caller
 *    (e.g. the server's mcp-launcher) is responsible for applying the
 *    runtimePolicy stdio env allowlist before constructing this.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { McpConnectionError, classifyMcpError } from './handshake';
import type {
  McpConnector,
  McpInitializeResult,
  McpServer,
  McpTool,
  McpToolCallResult,
} from './types';

export interface StdioConnectorOptions {
  /** executable to spawn (absolute path or resolvable on PATH) */
  command: string;
  args?: string[];
  /** extra env merged over the minimal default ({ PATH }); never inherits the full parent env */
  env?: Record<string, string>;
  cwd?: string;
  /** per-request timeout in ms (default 10000) */
  requestTimeoutMs?: number;
  /** max bytes accepted for a single stdout message (default 4 MiB) */
  maxResponseBytes?: number;
  /** reported in initialize's clientInfo */
  clientInfo?: { name: string; version: string };
  /** injectable clock for tests */
  now?: () => number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export class StdioMcpConnector implements McpConnector {
  private readonly opts: Required<Omit<StdioConnectorOptions, 'env' | 'cwd' | 'clientInfo' | 'now'>> &
    Pick<StdioConnectorOptions, 'env' | 'cwd' | 'clientInfo' | 'now'>;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private stdoutBuf = '';
  private stderrTail = '';
  private launchError: Error | null = null;

  constructor(opts: StdioConnectorOptions) {
    if (!opts.command || !opts.command.trim()) {
      throw new Error('mcp: StdioMcpConnector requires a non-empty command');
    }
    this.opts = {
      command: opts.command,
      args: opts.args ?? [],
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_BYTES,
      env: opts.env,
      cwd: opts.cwd,
      clientInfo: opts.clientInfo,
      now: opts.now,
    };
  }

  async launch(server: McpServer): Promise<void> {
    if (server.transport !== 'stdio') {
      throw new McpConnectionError(
        'protocol',
        'launch',
        `mcp: StdioMcpConnector only supports stdio servers (got ${server.transport})`,
      );
    }
    if (this.child) return; // idempotent: one child per connector
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (this.opts.env) Object.assign(env, this.opts.env);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args, {
        env,
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('error', (err) => {
        this.launchError = err instanceof Error ? err : new Error(String(err));
        this.failAllPending(this.launchError);
        reject(this.launchError);
      });
      child.once('spawn', () => {
        this.child = child;
        this.wire(child);
        resolve();
      });
    });
  }

  async initialize(server: McpServer, clientProtocolVersions: string[]): Promise<McpInitializeResult> {
    const child = this.requireChild(server, 'protocol');
    void child;
    if (clientProtocolVersions.length === 0) {
      throw new McpConnectionError('protocol', 'protocol', 'mcp: no client protocol versions to propose');
    }
    const proposed = clientProtocolVersions[0];
    let raw: unknown;
    try {
      raw = await this.request('initialize', {
        protocolVersion: proposed,
        capabilities: {},
        clientInfo: this.opts.clientInfo ?? { name: 'ai-factory', version: '0.1.0' },
      });
    } catch (err) {
      throw this.asProtocolError(err, server, 'initialize');
    }
    const result = asObject(raw, 'initialize result');
    const negotiated = typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
    if (!clientProtocolVersions.includes(negotiated)) {
      throw new McpConnectionError(
        'protocol',
        'protocol',
        `mcp: server ${server.name}@${server.version} speaks protocol '${negotiated}', ` +
          `which is not in the client's supported set [${clientProtocolVersions.join(', ')}]`,
      );
    }
    // Per MCP lifecycle: the client MUST send notifications/initialized after
    // a successful initialize before issuing any other request.
    this.notify('notifications/initialized', {});
    const serverInfoRaw = asObject(result.serverInfo, 'serverInfo', true);
    return {
      protocolVersion: negotiated,
      extensions: Array.isArray(result.extensions)
        ? result.extensions.filter((e): e is string => typeof e === 'string')
        : [],
      serverInfo:
        serverInfoRaw && (typeof serverInfoRaw.name === 'string' || typeof serverInfoRaw.version === 'string')
          ? {
              ...(typeof serverInfoRaw.name === 'string' ? { name: serverInfoRaw.name } : {}),
              ...(typeof serverInfoRaw.version === 'string' ? { version: serverInfoRaw.version } : {}),
            }
          : undefined,
    };
  }

  async listTools(server: McpServer): Promise<McpTool[]> {
    this.requireChild(server, 'tools');
    let raw: unknown;
    try {
      raw = await this.request('tools/list', {});
    } catch (err) {
      throw this.asProtocolError(err, server, 'tools/list');
    }
    const result = asObject(raw, 'tools/list result');
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((t, i) => {
      const o = asObject(t, `tools/list tool[${i}]`);
      if (typeof o.name !== 'string' || !o.name) {
        throw new McpConnectionError('protocol', 'tools', `mcp: tools/list returned a tool without a name`);
      }
      const tool: McpTool = { name: o.name };
      if (typeof o.description === 'string') tool.description = o.description;
      return tool;
    });
  }

  async callTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.requireChild(server, 'execution');
    let raw: unknown;
    try {
      raw = await this.request('tools/call', { name: tool, arguments: args });
    } catch (err) {
      throw this.asProtocolError(err, server, `tools/call ${tool}`);
    }
    const result = asObject(raw, 'tools/call result');
    if (result.isError === true) {
      const text = extractText(result.content);
      return { ok: false, isError: true, errorText: text ?? 'tool returned isError', content: result.content };
    }
    return { ok: true, content: result.content };
  }

  async close(_server: McpServer): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAllPending(new Error('mcp: connector closed'));
    if (!child || child.exitCode !== null || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  // -- internals -----------------------------------------------------------

  private requireChild(server: McpServer, stage: McpConnectionError['stage']): ChildProcess {
    if (!this.child) {
      const cause = this.launchError ? `: ${this.launchError.message}` : '';
      throw new McpConnectionError('unreachable', stage, `mcp: ${server.name}@${server.version} is not launched${cause}`);
    }
    return this.child;
  }

  private asProtocolError(err: unknown, server: McpServer, what: string): McpConnectionError {
    if (err instanceof McpConnectionError) return err;
    const cls = classifyMcpError(err, 'protocol');
    const msg = err instanceof Error ? err.message : String(err ?? '');
    const tail = this.stderrTail ? ` | server stderr tail: ${this.stderrTail.slice(-400)}` : '';
    return new McpConnectionError(cls, 'protocol', `mcp: ${server.name}@${server.version} ${what} failed (${cls}): ${msg}${tail}`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) {
      return Promise.reject(new Error('mcp: child stdin is not writable'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp: request '${method}' timed out after ${this.opts.requestTimeoutMs}ms`));
      }, this.opts.requestTimeoutMs);
      // Avoid unref'd timers keeping a test process alive longer than needed.
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(payload, (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private wire(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    const onGone = (code: number | null, signal: string | null) => {
      this.failAllPending(new Error(`mcp: server process exited (code=${code}, signal=${signal})`));
      if (this.child === child) this.child = null;
    };
    child.once('exit', onGone);
    child.once('error', (err) => {
      this.failAllPending(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      if (line.length > this.opts.maxResponseBytes) {
        this.failAllPending(new Error(`mcp: stdout message exceeds ${this.opts.maxResponseBytes} bytes`));
        continue;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON stdout chatter from a misbehaving server is not protocol;
        // keep it out of the pending map rather than failing everything.
        continue;
      }
      this.dispatch(msg);
    }
    // Guard the buffer itself against unbounded growth when no newline arrives.
    if (this.stdoutBuf.length > this.opts.maxResponseBytes) {
      this.stdoutBuf = '';
      this.failAllPending(new Error(`mcp: stdout buffer exceeded ${this.opts.maxResponseBytes} bytes without a newline`));
    }
  }

  private dispatch(msg: unknown): void {
    const o = asObject(msg, 'jsonrpc message', true);
    if (!o || o.jsonrpc !== '2.0') return;
    if (o.id !== undefined && o.id !== null && (typeof o.id === 'number' || typeof o.id === 'string')) {
      // Response to one of our requests — or a server-initiated request.
      const pending = this.pending.get(o.id);
      if (pending) {
        this.pending.delete(o.id);
        clearTimeout(pending.timer);
        if ('error' in o && o.error !== undefined && o.error !== null) {
          const e = asObject(o.error, 'jsonrpc error', true) ?? {};
          const message = typeof e.message === 'string' ? e.message : 'unknown JSON-RPC error';
          const code = typeof e.code === 'number' ? ` (${e.code})` : '';
          pending.reject(Object.assign(new Error(`JSON-RPC error${code}: ${message}`), { code: e.code }));
        } else {
          pending.resolve((o as { result?: unknown }).result);
        }
        return;
      }
      // Server-initiated request we did not send: answer Method-not-found.
      if (typeof o.method === 'string') {
        this.sendRaw({ jsonrpc: '2.0', id: o.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    // Notification (no id): read and discard — never treat as a response.
  }

  private sendRaw(msg: unknown): void {
    const child = this.child;
    if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}

function asObject(value: unknown, what: string, lenient = false): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (lenient) return {};
  throw new McpConnectionError('protocol', 'protocol', `mcp: expected ${what} to be an object`);
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
