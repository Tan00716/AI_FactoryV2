/**
 * Minimal HTTP client for the AI Factory API (W-D headless CLI).
 *
 * Zero dependencies: node:http/https only. The server authenticates with
 * `Authorization: Bearer <token>` when FACTORY_API_TOKEN is configured;
 * the CLI reads the token from --token or the FACTORY_API_TOKEN env var
 * (same source the desktop/server use — never printed, never logged).
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequestArgs } from 'node:http';

export interface HttpResult {
  status: number;
  body: unknown;
}

export interface HttpClient {
  request(method: string, path: string, body?: unknown): Promise<HttpResult>;
}

export function resolveToken(explicit: string | undefined): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  const env = process.env.FACTORY_API_TOKEN;
  if (env && env.trim()) return env.trim();
  return undefined;
}

export function createHttpClient(baseUrl: string, token?: string): HttpClient {
  const base = new URL(baseUrl);
  const useHttps = base.protocol === 'https:';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;

  return {
    request(method: string, path: string, body?: unknown): Promise<HttpResult> {
      return new Promise((resolvePromise, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const opts: ClientRequestArgs = {
          hostname: base.hostname,
          port: base.port ? Number(base.port) : useHttps ? 443 : 80,
          path,
          method,
          headers: payload
            ? { ...headers, 'content-length': String(Buffer.byteLength(payload)) }
            : headers,
          timeout: 30_000,
        };
        const req = (useHttps ? httpsRequest : httpRequest)(opts, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              /* keep raw text */
            }
            resolvePromise({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('request timed out')));
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
