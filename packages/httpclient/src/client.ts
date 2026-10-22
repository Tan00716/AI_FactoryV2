/**
 * node:http(s) sender + assertion evaluator (round-4 task A6).
 *
 * Zero dependencies — plain node:http/node:https, so this package stays
 * honest about what a request is (no hidden redirects, no cookie jar).
 *
 * Honest boundaries:
 *  - Redirects are NOT followed; a 3xx is reported as-is with its headers.
 *  - Response bodies are capped at BODY_CAP_BYTES (the rest is dropped and
 *    flagged in the result via `truncated: true` on the raw text field is
 *    not possible, so we append a marker comment to the audit-safe note —
 *    actually we record `bytes` and cap bodyText; callers are told the cap).
 *  - The egress firewall decision is made by the CALLER (server route),
 *    never here — this module dials whatever URL it is given.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { mergeVariables, substituteVars } from './envs';
import {
  HttpClientError,
  HttpRequestSpec,
  HttpRunOptions,
  HttpRunResult,
  type AssertionResult,
  type AssertionSpec,
} from './types';

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Response body capture cap — beyond this the body text is truncated. */
export const BODY_CAP_BYTES = 5 * 1024 * 1024;
/** Hard cap on request body size we will send. */
export const REQUEST_BODY_CAP_BYTES = 10 * 1024 * 1024;

function specLabel(spec: AssertionSpec): string {
  switch (spec.type) {
    case 'status':
      return `status == ${spec.expected}`;
    case 'status-class':
      return `status in ${spec.expected}`;
    case 'header':
      return `header ${spec.name} ${spec.op} ${JSON.stringify(spec.expected)}`;
    case 'body-contains':
      return `body contains ${JSON.stringify(spec.text)}`;
    case 'json-path':
      return spec.op === 'exists' ? `json-path ${spec.path} exists` : `json-path ${spec.path} == ${JSON.stringify(spec.expected)}`;
    case 'max-time-ms':
      return `max-time-ms ${spec.ms}`;
  }
}

/** Minimal dot-path lookup: `$.a.b`, `$.a[0].b`, `$` itself. No wildcards. */
export function lookupJsonPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let p = path.trim();
  if (p === '$') return { found: true, value: root };
  if (!p.startsWith('$.')) return { found: false };
  p = p.slice(2);
  const segments = p.split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return { found: false };
    const m = seg.match(/^([A-Za-z0-9_\-]+)((?:\[\d+\])*)$/);
    if (!m) return { found: false };
    if (typeof cur !== 'object' || cur === null) return { found: false };
    const rec = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, m[1])) return { found: false };
    cur = rec[m[1]];
    const idxs = m[2].match(/\[(\d+)\]/g) ?? [];
    for (const ix of idxs) {
      const n = parseInt(ix.slice(1, -1), 10);
      if (!Array.isArray(cur) || n >= cur.length) return { found: false };
      cur = cur[n];
    }
  }
  return { found: true, value: cur };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Evaluate one assertion against a completed response. */
export function evaluateAssertion(
  spec: AssertionSpec,
  result: Pick<HttpRunResult, 'status' | 'headers' | 'bodyText' | 'bodyJson' | 'durationMs'>,
): AssertionResult {
  const label = specLabel(spec);
  switch (spec.type) {
    case 'status': {
      const got = result.status ?? -1;
      const passed = got === spec.expected;
      return { spec, passed, detail: `${label} (got ${got})` };
    }
    case 'status-class': {
      const got = result.status ?? -1;
      const want = parseInt(spec.expected[0], 10);
      const passed = Math.floor(got / 100) === want;
      return { spec, passed, detail: `${label} (got ${got})` };
    }
    case 'header': {
      const got = result.headers?.[spec.name];
      if (got === undefined) return { spec, passed: false, detail: `${label} (header missing)` };
      const passed = spec.op === 'eq' ? got === spec.expected : got.includes(spec.expected);
      return { spec, passed, detail: `${label} (got ${JSON.stringify(got)})` };
    }
    case 'body-contains': {
      const body = result.bodyText ?? '';
      const passed = body.includes(spec.text);
      return { spec, passed, detail: `${label} (body ${body.length} bytes)` };
    }
    case 'json-path': {
      if (result.bodyJson === undefined) {
        return { spec, passed: false, detail: `${label} (body is not JSON)` };
      }
      const { found, value } = lookupJsonPath(result.bodyJson, spec.path);
      if (spec.op === 'exists') return { spec, passed: found, detail: `${label} (${found ? 'found' : 'missing'})` };
      const passed = found && deepEqual(value, spec.expected);
      return {
        spec,
        passed,
        detail: `${label} (got ${found ? JSON.stringify(value) : '<missing>'})`,
      };
    }
    case 'max-time-ms': {
      const ms = result.durationMs ?? Number.POSITIVE_INFINITY;
      const passed = ms <= spec.ms;
      return { spec, passed, detail: `${label} (took ${Math.round(ms)}ms)` };
    }
  }
}

export interface SendOptions {
  defaultTimeoutMs?: number;
}

/**
 * Send one request (variables already merged by the caller via mergeVariables
 * + substituteVars, or pass options and let this do it).
 */
export function sendHttpRequest(
  spec: HttpRequestSpec,
  options: HttpRunOptions & SendOptions = {},
): Promise<HttpRunResult> {
  const vars = mergeVariables(options);
  const urlText = substituteVars(spec.url, vars);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers)) headers[k] = substituteVars(v, vars);
  const bodyText = spec.body !== undefined ? substituteVars(spec.body, vars) : undefined;
  if (bodyText !== undefined && Buffer.byteLength(bodyText) > REQUEST_BODY_CAP_BYTES) {
    throw new HttpClientError(
      `request body too large (cap ${REQUEST_BODY_CAP_BYTES} bytes)`,
      'request-too-large',
    );
  }

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return Promise.resolve({
      id: spec.id,
      name: spec.name,
      method: spec.method,
      url: urlText,
      assertions: [],
      ok: false,
      error: `invalid URL: ${urlText}`,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.resolve({
      id: spec.id,
      name: spec.name,
      method: spec.method,
      url: urlText,
      assertions: [],
      ok: false,
      error: `unsupported protocol: ${url.protocol} (http/https only)`,
    });
  }

  const timeoutMs = spec.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  return new Promise((resolve) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: spec.method,
        headers: { ...headers, ...(bodyText !== undefined ? { 'content-length': String(Buffer.byteLength(bodyText)) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received <= BODY_CAP_BYTES) chunks.push(c);
        });
        res.on('end', () => {
          const durationMs = Date.now() - start;
          const body = Buffer.concat(chunks).toString('utf8');
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          let bodyJson: unknown;
          const ct = resHeaders['content-type'] ?? '';
          if (ct.includes('json') && body.length > 0) {
            try {
              bodyJson = JSON.parse(body);
            } catch {
              /* not JSON after all — bodyJson stays undefined */
            }
          }
          const base: HttpRunResult = {
            id: spec.id,
            name: spec.name,
            method: spec.method,
            url: urlText,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: resHeaders,
            bodyText: body,
            bodyJson,
            durationMs,
            bytes: received,
            assertions: [],
            ok: false,
          };
          base.assertions = spec.assertions.map((a) => evaluateAssertion(a, base));
          base.ok = base.assertions.every((a) => a.passed);
          resolve(base);
        });
        res.on('error', (e) => {
          resolve({
            id: spec.id,
            name: spec.name,
            method: spec.method,
            url: urlText,
            assertions: [],
            ok: false,
            durationMs: Date.now() - start,
            error: `response error: ${(e as Error).message}`,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      resolve({
        id: spec.id,
        name: spec.name,
        method: spec.method,
        url: urlText,
        assertions: [],
        ok: false,
        durationMs: Date.now() - start,
        error: (e as Error).message,
      });
    });
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

export { mergeVariables, substituteVars };
