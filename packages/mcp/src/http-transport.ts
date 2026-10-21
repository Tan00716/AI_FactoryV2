/**
 * @ai-factory/mcp — shared HTTP/SSE plumbing for the remote connectors.
 *
 * Internal module (imported by streamable-connector.ts; the SseParser
 * also decodes Streamable HTTP's SSE-stream response shape).
 * Zero external dependencies — node:http / node:https only.
 *
 * Honest boundaries (documented per surface):
 *  - TLS itself is negotiated by the node/OS stack; this layer only
 *    *decides* whether a URL may carry credentials (evaluateServerUrl
 *    + an explicit loopback carve-out for http://127.0.0.1|localhost,
 *    per RFC 8252 §7.3 native-app practice — documented, not silent).
 *  - Redirects are never followed by the HTTP client itself; the
 *    connector consults evaluateRedirect() and re-issues manually, so
 *    the credential-forwarding rule is enforced at the decision point.
 *  - SSE parsing is a minimal event/data parser: comments (:) are
 *    ignored, multi-line data is joined with '\n', and a blank line
 *    dispatches the event. Malformed frames are skipped, never fatal.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { McpConnectionError, classifyMcpError } from './handshake';
import { evaluateRedirect, evaluateServerUrl } from './runtimePolicy';
import type { McpRuntimePolicy, McpServer } from './types';

export interface HttpRequestOptions {
  method: string;
  headers?: Record<string, string>;
  /** JSON-serializable body (stringified with Content-Type: application/json) */
  jsonBody?: unknown;
  /** raw string body (caller sets Content-Type) */
  textBody?: string;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Process-wide egress guard for doHttpRequest (second-round task ⑦).
 * The server installs one via setMcpHttpGuard (see
 * apps/server/src/egress.ts + index.ts wiring); the guard may throw to
 * refuse an outbound call (e.g. an EGRESS_BLOCKED error). This single
 * helper backs every remote-MCP Streamable HTTP call AND the OAuth 2.1
 * fetches (discovery, Client ID Metadata Document, token endpoint), so
 * one guard covers the whole MCP remote egress surface. Default: none
 * — standalone package behavior is unchanged.
 */
export type McpHttpGuard = (url: string) => void;
let mcpHttpGuard: McpHttpGuard | null = null;

/** Install (or clear with null) the process-wide doHttpRequest egress guard. */
export function setMcpHttpGuard(fn: McpHttpGuard | null): void {
  mcpHttpGuard = fn;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Hostnames treated as loopback for the http-credential carve-out (RFC 8252 §7.3). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Decide whether `url` may be used for this server, honouring the
 * §34.3 runtime policy. Loopback http is allowed even with
 * credentials (native-app/OAuth practice); anything else needs https
 * when credentials are present. Throws McpConnectionError on denial.
 */
export function assertServerUrlUsable(
  policy: McpRuntimePolicy | undefined,
  url: string,
  opts: { credentialsPresent: boolean; server: McpServer; stage: McpConnectionError['stage'] },
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpConnectionError('protocol', opts.stage, `mcp: unusable server URL '${url}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpConnectionError(
      'protocol',
      opts.stage,
      `mcp: server URL must be http(s), got '${parsed.protocol}'`,
    );
  }
  // Secure default even without a runtime policy: credentials never go
  // over plain http to a non-loopback host. (The §34.3
  // requireTlsForCredentials check below covers the policy-carrying
  // case; this covers policy-less connectors.)
  if (opts.credentialsPresent && parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new McpConnectionError(
      'protocol',
      opts.stage,
      `mcp: refusing to send credentials over plain http to non-loopback host '${parsed.hostname}'`,
    );
  }
  if (policy) {
    const verdict = evaluateServerUrl(policy, url, { credentialsPresent: opts.credentialsPresent });
    // evaluateServerUrl has no loopback carve-out; re-check with it when
    // the only complaint is the TLS rule on a loopback URL.
    if (!verdict.allowed) {
      const tlsOnly =
        verdict.reason.includes('credentials require TLS') &&
        isLoopbackHost(parsed.hostname);
      if (!tlsOnly) {
        throw new McpConnectionError('protocol', opts.stage, `mcp: ${verdict.reason}`);
      }
    }
  }
}

/**
 * Follow one redirect hop per the §34.3 policy. Returns the new URL to
 * use and whether credentials may be forwarded. Throws when the
 * redirect must not be followed.
 */
export function applyRedirectPolicy(
  policy: McpRuntimePolicy | undefined,
  fromUrl: string,
  location: string,
  opts: { credentialsPresent: boolean; server: McpServer; stage: McpConnectionError['stage'] },
): { url: string; forwardCredentials: boolean } {
  const toUrl = new URL(location, fromUrl).toString();
  if (!policy) {
    throw new McpConnectionError(
      'protocol',
      opts.stage,
      `mcp: refusing redirect ${fromUrl} -> ${toUrl} (no runtime policy; default stance: do not follow)`,
    );
  }
  const verdict = evaluateRedirect(policy, fromUrl, toUrl, {
    credentialsPresent: opts.credentialsPresent,
  });
  if (!verdict.allowed) {
    throw new McpConnectionError('protocol', opts.stage, `mcp: ${verdict.reason}`);
  }
  return { url: toUrl, forwardCredentials: verdict.forwardCredentials };
}

export function doHttpRequest(url: string, opts: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    // Egress firewall (global layer): a throwing guard rejects this call
    // before any socket is opened — covers remote-MCP Streamable HTTP and
    // the OAuth 2.1 discovery/token fetches that share this helper.
    if (mcpHttpGuard) {
      try {
        mcpHttpGuard(url);
      } catch (err) {
        reject(err);
        return;
      }
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`mcp: unparseable URL '${url}'`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    let body: string | undefined;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.jsonBody !== undefined) {
      body = JSON.stringify(opts.jsonBody);
      headers['content-type'] = 'application/json';
    } else if (opts.textBody !== undefined) {
      body = opts.textBody;
    }
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = lib.request(
      url,
      { method: opts.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (c: Buffer) => {
          if (tooLarge) return;
          size += c.length;
          if (size > opts.maxBytes) {
            tooLarge = true;
            req.destroy(new Error(`mcp: response exceeds ${opts.maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (tooLarge) return; // destroy() already rejected below via 'error'
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') flat[k.toLowerCase()] = v;
            else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(', ');
          }
          resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => reject(err));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`mcp: HTTP ${opts.method} ${url} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Minimal SSE frame parser. Feed chunks; complete events are delivered
 * to onEvent. A blank line dispatches; 'event:' sets the type
 * (default 'message'); 'data:' lines are joined with '\n'.
 */
export class SseParser {
  private buf = '';
  private curEvent = 'message';
  private curData: string[] = [];
  private readonly onEvent: (e: SseEvent) => void;

  constructor(onEvent: (e: SseEvent) => void) {
    this.onEvent = onEvent;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const data = this.curData.join('\n');
        const event = this.curEvent;
        this.curEvent = 'message';
        this.curData = [];
        // Dispatch even empty-data events: some servers send bare
        // `event: endpoint` heartbeats; the connector filters by type.
        this.onEvent({ event, data });
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') this.curEvent = value || 'message';
      else if (field === 'data') this.curData.push(value);
      // 'id:' / 'retry:' are intentionally ignored.
    }
  }
}

/** Wrap a raw error from the HTTP layer into a classified McpConnectionError. */
export function asMcpHttpError(
  err: unknown,
  server: McpServer,
  stage: McpConnectionError['stage'],
  what: string,
): McpConnectionError {
  if (err instanceof McpConnectionError) return err;
  const cls = classifyMcpError(err, stage);
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return new McpConnectionError(cls, stage, `mcp: ${server.name}@${server.version} ${what} failed (${cls}): ${msg}`);
}

export function parseJsonRpcResponse(
  raw: string,
  server: McpServer,
  stage: McpConnectionError['stage'],
  what: string,
): Record<string, unknown> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new McpConnectionError('protocol', stage, `mcp: ${server.name}@${server.version} ${what}: not JSON`);
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new McpConnectionError('protocol', stage, `mcp: ${server.name}@${server.version} ${what}: not an object`);
  }
  return msg as Record<string, unknown>;
}
