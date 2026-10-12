/**
 * @ai-factory/mcp — initialize handshake + failure classification (§34.2, §34.4).
 *
 * §34.2 [S4]: "实现 MUST 保存 negotiated version 与 extension set" — a
 * successful handshake is not done until the negotiated protocol
 * version and extension set are persisted on the registration record
 * (registry.recordNegotiation). performHandshake is that write path:
 * launch → initialize → persist.
 *
 * §34.4: loss of contact is first CLASSIFIED (unreachable / protocol /
 * tool / timeout / unknown); the retry and circuit-breaker layers in
 * resilience.ts key every decision off this classification. Notably,
 * only 'unreachable' and 'timeout' mean "the request almost certainly
 * never executed" — a protocol or tool failure may already have had
 * side effects, and §34.4 forbids blindly retrying unknown side effects.
 */
import { McpRegistry } from './registry';
import {
  McpConnector,
  McpFailureClass,
  McpInitializeResult,
  McpServer,
} from './types';

/** The protocol baseline this build negotiates against (§34.2: 2026-07-28 line). */
export const CLIENT_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28', '2025-06-18', '2025-03-26'];

/** A connector failure, tagged with the stage that produced it and its §34.4 class. */
export class McpConnectionError extends Error {
  readonly failureClass: McpFailureClass;
  readonly stage: 'launch' | 'protocol' | 'tools' | 'execution';

  constructor(
    failureClass: McpFailureClass,
    stage: McpConnectionError['stage'],
    message: string,
  ) {
    super(message);
    this.name = 'McpConnectionError';
    this.failureClass = failureClass;
    this.stage = stage;
  }
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR']);

/**
 * Classify an arbitrary connector error into a §34.4 failure class.
 * `stage` disambiguates: a JSON-RPC error object during initialize is a
 * protocol failure; the same object during a tool call is a tool failure.
 */
export function classifyMcpError(err: unknown, stage: McpConnectionError['stage']): McpFailureClass {
  if (err instanceof McpConnectionError) return err.failureClass;
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if ((code && TIMEOUT_CODES.has(code)) || name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/i.test(message)) {
    return 'timeout';
  }
  if ((code && UNREACHABLE_CODES.has(code)) || /spawn .* ENOENT/.test(message) || /connection refused/i.test(message)) {
    return 'unreachable';
  }
  // JSON-RPC style error objects carry a numeric code.
  if (typeof e?.code === 'number') {
    return stage === 'execution' ? 'tool' : 'protocol';
  }
  if (stage === 'launch') return 'unreachable';
  if (stage === 'execution') return 'tool';
  if (/parse|invalid|unexpected token|handshake|initialize/i.test(message)) return 'protocol';
  return 'unknown';
}

export interface HandshakeOptions {
  /** protocol versions this client can speak, newest first */
  clientProtocolVersions?: readonly string[];
}

export interface HandshakeResult {
  server: string;
  version: string;
  negotiatedVersion: string;
  extensionSet: string[];
  serverInfo?: { name?: string; version?: string };
  /**
   * §34.2 — the handshake reported a tool/prompt set that differs from
   * the registered binding: the old binding is stale and must go
   * through a compatibility check before further calls. The registered
   * metadata is NOT silently overwritten by a handshake.
   */
  bindingStale: boolean;
  staleDetail?: string;
}

/**
 * Run the initialize handshake against a registered server and persist
 * the negotiated version + extension set on its record. Throws
 * McpConnectionError (classified, stage-tagged) on any failure.
 */
export async function performHandshake(
  registry: McpRegistry,
  connector: McpConnector,
  name: string,
  version: string,
  opts: HandshakeOptions = {},
): Promise<HandshakeResult> {
  const server = registry.get(name, version);
  if (!server) throw new Error(`mcp: cannot handshake — ${name}@${version} is not registered`);

  let init: McpInitializeResult;
  try {
    await connector.launch(server);
  } catch (err) {
    throw wrap(err, 'launch', server);
  }
  try {
    init = await connector.initialize(server, [...(opts.clientProtocolVersions ?? CLIENT_PROTOCOL_VERSIONS)]);
  } catch (err) {
    throw wrap(err, 'protocol', server);
  }

  const extensionSet = init.extensions ? [...init.extensions] : [];
  registry.recordNegotiation(name, version, {
    negotiatedVersion: init.protocolVersion,
    extensionSet,
  });

  const stale = detectStaleBinding(server, init);
  return {
    server: name,
    version,
    negotiatedVersion: init.protocolVersion,
    extensionSet,
    serverInfo: init.serverInfo,
    bindingStale: stale !== undefined,
    staleDetail: stale,
  };
}

function wrap(err: unknown, stage: McpConnectionError['stage'], server: McpServer): McpConnectionError {
  if (err instanceof McpConnectionError) return err;
  const cls = classifyMcpError(err, stage);
  const msg = err instanceof Error ? err.message : String(err);
  return new McpConnectionError(cls, stage, `${server.name}@${server.version} ${stage} failed (${cls}): ${msg}`);
}

function detectStaleBinding(server: McpServer, init: McpInitializeResult): string | undefined {
  const parts: string[] = [];
  if (init.tools) {
    const registered = new Set(server.tools.map((t) => t.name));
    const reported = new Set(init.tools.map((t) => t.name));
    const added = [...reported].filter((t) => !registered.has(t));
    const removed = [...registered].filter((t) => !reported.has(t));
    if (added.length || removed.length) {
      parts.push(`tools changed (added: ${added.join(', ') || '—'}; removed: ${removed.join(', ') || '—'})`);
    }
  }
  if (init.prompts && server.prompts) {
    const registered = new Set(server.prompts.map((p) => p.name));
    const reported = new Set(init.prompts.map((p) => p.name));
    if ([...reported].some((p) => !registered.has(p)) || [...registered].some((p) => !reported.has(p))) {
      parts.push('prompts changed');
    }
  }
  return parts.length ? parts.join('; ') : undefined;
}
