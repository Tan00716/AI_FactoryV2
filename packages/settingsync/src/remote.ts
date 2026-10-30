/**
 * Optional private-remote push/pull client (R7-#10).
 *
 * The remote is the user's own endpoint (a private git-hosted file
 * server, an object-storage presigned URL target, or any small HTTP
 * service that stores one JSON document at one URL). This client is
 * deliberately dumb: GET returns the document, PUT/POST stores it.
 * It never invents an account system, never retries with credentials,
 * and never logs the token or the document.
 *
 * Token resolution mirrors webhooks: FACTORY_SETTINGSYNC_TOKEN wins,
 * else the file named by FACTORY_SETTINGSYNC_TOKEN_FILE. No token is
 * ever persisted by this package — the route stores only the URL.
 * URLs with userinfo (embedded credentials) are rejected outright.
 */
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { validateSyncDoc } from './doc.js';
import type { SyncDoc } from './types.js';

export const REMOTE_TIMEOUT_MS = 15_000;
export const MAX_REMOTE_BYTES = 1_000_000;

/** Resolve the remote bearer token from the environment, or null. */
export function resolveRemoteToken(): string | null {
  const direct = (process.env['FACTORY_SETTINGSYNC_TOKEN'] ?? '').trim();
  if (direct) return direct;
  const file = (process.env['FACTORY_SETTINGSYNC_TOKEN_FILE'] ?? '').trim();
  if (!file) return null;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function validateRemoteUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('remote url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('remote url must be http(s)');
  }
  if (u.username || u.password) throw new Error('remote url must not embed credentials');
  return u.toString();
}

function requestOnce(
  url: string,
  method: string,
  token: string | null,
  body: string | null,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: `${u.pathname}${u.search}`,
        timeout: REMOTE_TIMEOUT_MS,
        headers: {
          ...(body !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_REMOTE_BYTES) tooLarge = true;
          else chunks.push(c);
        });
        res.on('end', () => {
          if (tooLarge) reject(new Error('remote response too large'));
          else resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('remote request timed out')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Upload a document. Throws on non-2xx; the caller audits only keys. */
export async function pushRemote(url: string, doc: SyncDoc, token: string | null): Promise<void> {
  const checked = validateRemoteUrl(url);
  const r = await requestOnce(checked, 'PUT', token, JSON.stringify(doc));
  if (r.status < 200 || r.status >= 300) throw new Error(`remote push failed: HTTP ${r.status}`);
}

/** Download and validate a document. Throws on non-200 or bad shape. */
export async function pullRemote(url: string, token: string | null): Promise<SyncDoc> {
  const checked = validateRemoteUrl(url);
  const r = await requestOnce(checked, 'GET', token, null);
  if (r.status !== 200) throw new Error(`remote pull failed: HTTP ${r.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    throw new Error('remote document is not valid JSON');
  }
  const v = validateSyncDoc(parsed);
  if (!v.ok || !v.doc) throw new Error(`remote document invalid: ${v.errors.join('; ')}`);
  return v.doc;
}
