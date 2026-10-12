/**
 * Fake MCP server connector for tests — an in-process McpConnector
 * whose per-level behavior is configured by the test: launch /
 * initialize / listTools / callTool can each succeed, return data, or
 * throw a classifiable error. Records every call in order.
 */
import type {
  McpConnector,
  McpInitializeResult,
  McpServer,
  McpTool,
  McpToolCallResult,
} from '../../src/index';

export interface FakeMcpBehavior {
  launchError?: unknown;
  initializeError?: unknown;
  protocolVersion?: string;
  extensions?: string[];
  serverInfo?: { name?: string; version?: string };
  /** tools reported inside the initialize result */
  handshakeTools?: McpTool[];
  /** tools/list result */
  tools?: McpTool[];
  listToolsError?: unknown;
  callResults?: Record<string, McpToolCallResult>;
  callError?: unknown;
  callErrors?: Record<string, unknown>;
}

export class FakeMcpConnector implements McpConnector {
  readonly calls: string[] = [];
  initializeCount = 0;

  constructor(private behavior: FakeMcpBehavior = {}) {}

  async launch(_server: McpServer): Promise<void> {
    this.calls.push('launch');
    if (this.behavior.launchError) throw this.behavior.launchError;
  }

  async initialize(_server: McpServer, _clientProtocolVersions: string[]): Promise<McpInitializeResult> {
    this.calls.push('initialize');
    this.initializeCount += 1;
    if (this.behavior.initializeError) throw this.behavior.initializeError;
    return {
      protocolVersion: this.behavior.protocolVersion ?? '2026-07-28',
      extensions: this.behavior.extensions ?? [],
      serverInfo: this.behavior.serverInfo ?? { name: 'fake', version: '1.0.0' },
      tools: this.behavior.handshakeTools,
    };
  }

  async listTools(_server: McpServer): Promise<McpTool[]> {
    this.calls.push('listTools');
    if (this.behavior.listToolsError) throw this.behavior.listToolsError;
    return this.behavior.tools ?? [];
  }

  async callTool(_server: McpServer, tool: string, _args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.calls.push(`callTool:${tool}`);
    const perTool = this.behavior.callErrors?.[tool];
    if (perTool) throw perTool;
    if (this.behavior.callError) throw this.behavior.callError;
    return this.behavior.callResults?.[tool] ?? { ok: true, content: 'ok' };
  }

  async close(_server: McpServer): Promise<void> {
    this.calls.push('close');
  }
}

/** Error factories producing the shapes classifyMcpError keys off. */
export const errUnreachable = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
export const errSpawnMissing = () => Object.assign(new Error('spawn /bin/false-mcp ENOENT'), { code: 'ENOENT' });
export const errTimeout = () => Object.assign(new Error('request timed out after 5000ms'), { code: 'ETIMEDOUT' });
export const errJsonRpc = (message = 'Method not found') => Object.assign(new Error(message), { code: -32601 });
