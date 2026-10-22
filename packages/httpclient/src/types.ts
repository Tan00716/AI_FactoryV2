/**
 * @ai-factory/httpclient — types (round-4 task A6, JetBrains HTTP Client style).
 *
 * Zero-dependency. The package is pure: parsing, variable substitution,
 * assertion evaluation and the node:http(s) sender. The egress firewall
 * decision is NOT made here — callers (the server route) gate each URL
 * through the injected egress gate before sending.
 */

/** Supported request methods. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** One assertion attached to a request (parsed from `> ...` lines). */
export type AssertionSpec =
  | { type: 'status'; op: 'eq'; expected: number }
  | { type: 'status-class'; expected: '2xx' | '3xx' | '4xx' | '5xx' }
  | { type: 'header'; name: string; op: 'eq' | 'contains'; expected: string }
  | { type: 'body-contains'; text: string }
  | { type: 'json-path'; path: string; op: 'eq' | 'exists'; expected?: unknown }
  | { type: 'max-time-ms'; ms: number };

/** One parsed request from a .http file. */
export interface HttpRequestSpec {
  /** Stable 1-based index in the file. */
  id: string;
  /** Name from the `### name` separator line (empty when anonymous). */
  name: string;
  method: HttpMethod;
  /** Raw URL — may contain `{{var}}` placeholders. */
  url: string;
  headers: Record<string, string>;
  /** Raw body text (may contain `{{var}}`), undefined when absent. */
  body?: string;
  /** Per-request timeout override in ms. */
  timeoutMs?: number;
  assertions: AssertionSpec[];
}

/** One named environment: a bag of variables. `baseUrl` is just a variable. */
export interface HttpEnvironment {
  vars: Record<string, string>;
}

export interface HttpRunOptions {
  environments?: Record<string, HttpEnvironment>;
  /** Selected environment name (must exist in `environments` when set). */
  environment?: string;
  /** Explicit variables — win over environment vars on conflict. */
  variables?: Record<string, string>;
  /** Default per-request timeout in ms when the request has none. */
  defaultTimeoutMs?: number;
}

export interface AssertionResult {
  spec: AssertionSpec;
  passed: boolean;
  /** Human-readable one-liner, e.g. `status == 200 (got 404)`. */
  detail: string;
}

/** Result of one sent (or blocked/failed) request. */
export interface HttpRunResult {
  id: string;
  name: string;
  method: string;
  /** URL after variable substitution. */
  url: string;
  /** True when the egress gate refused the URL (nothing was dialed). */
  blocked?: boolean;
  blockedReason?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  /** Response body as text (capped; see BODY_CAP_BYTES). */
  bodyText?: string;
  /** Parsed JSON body when the response was JSON and parseable. */
  bodyJson?: unknown;
  durationMs?: number;
  bytes?: number;
  assertions: AssertionResult[];
  /** True when the request was sent, all assertions passed, no error. */
  ok: boolean;
  /** Transport-level failure (DNS, timeout, socket), never sent. */
  error?: string;
}

/** Parse/render failures carry a stable code. */
export class HttpClientError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HttpClientError';
    this.code = code;
  }
}
