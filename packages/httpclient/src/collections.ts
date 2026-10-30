/**
 * @ai-factory/httpclient — collections, API environments and auth profiles
 * (round-7 task R7-#9: API client deepening, on top of round-4 A6).
 *
 * Pure validation + redaction. Persistence lives in the server route
 * (two 0600 files under the user data dir); this module never touches
 * the filesystem, so it stays importable from the desktop-safe surface
 * in principle — but the desktop only talks to it over HTTP.
 *
 * Secret discipline (the whole point of this module):
 *  - A collection request never carries a secret value: headers that
 *    carry credentials are applied at send time from an auth profile.
 *  - An environment marks secret variables by NAME (secretNames); the
 *    values live in a separate secrets file and are NEVER returned by
 *    any API response — list/get endpoints substitute `<redacted>`.
 *  - History entries store the pre-substitution URL template, never the
 *    substituted URL (a substituted secret in a URL must not land at
 *    rest), and never store Authorization / api-key header values.
 */

import { HttpClientError } from './types';
import type { HttpMethod } from './types';

export const REDACTED = '<redacted>';
export const MAX_COLLECTIONS = 32;
export const MAX_REQUESTS_PER_COLLECTION = 200;
export const MAX_AUTH_PROFILES = 64;
export const MAX_ENVIRONMENTS = 32;
export const MAX_HISTORY = 200;

const NAME_RE = /^[A-Za-z0-9_\-. ]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const VAR_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const HEADER_RE = /^[A-Za-z0-9\-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(msg: string): HttpClientError {
  return new HttpClientError(msg, 'bad-collection');
}

/** One saved request inside a collection (no secret values, ever). */
export interface SavedRequest {
  id: string;
  name: string;
  method: HttpMethod;
  /** URL template — may contain `{{var}}` placeholders. */
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Auth profile id applied at send time (null = none). */
  authProfileId?: string | null;
  /** Environment name applied at send time (null = none). */
  environment?: string | null;
}

export interface HttpCollection {
  id: string;
  name: string;
  requests: SavedRequest[];
}

export type AuthKind = 'bearer' | 'basic' | 'apikey' | 'oauth2';

/**
 * An auth profile as STORED (metadata only). The secret itself lives in
 * the secrets file keyed by profile id, or in a process env var named by
 * `secretEnv`. `hasSecret` tells the UI a credential exists without
 * revealing it; `secretSource` says where it resolves from.
 */
export interface AuthProfile {
  id: string;
  name: string;
  kind: AuthKind;
  /** basic only: username (not secret). */
  username?: string;
  /** apikey only: header name (default `X-Api-Key`). */
  headerName?: string;
  /** 'stored' | 'env' | null — never the value itself. */
  secretSource: 'stored' | 'env' | null;
  /** env only: process env var name the secret resolves from. */
  secretEnv?: string;
  hasSecret: boolean;
}

/** One API environment: plain vars + secret var NAMES (values separate). */
export interface ApiEnvironment {
  name: string;
  vars: Record<string, string>;
  secretNames: string[];
}

/** A history entry as stored/returned (redacted by construction). */
export interface HistoryEntry {
  id: string;
  at: number;
  rerunOf?: string;
  collectionId?: string | null;
  collectionName?: string | null;
  requestName: string;
  method: string;
  /** Pre-substitution URL template — never the substituted URL. */
  urlTemplate: string;
  environment?: string | null;
  authProfileId?: string | null;
  status?: number;
  durationMs?: number;
  blocked?: boolean;
  ok: boolean;
  error?: string;
  /** Stored spec for rerun: auth headers stripped at record time. */
  spec: {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
}

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function validateHeaders(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw bad(`${what} headers must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!HEADER_RE.test(k)) throw bad(`${what} bad header name ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || v.length > 10_000) throw bad(`${what} header ${k} must be a short string`);
    // Credential headers must come from an auth profile, never inline:
    // storing them here would put secrets in the collections file.
    if (k.toLowerCase() === 'authorization') {
      throw bad(`${what} must not carry an inline Authorization header (use an auth profile)`);
    }
    out[k] = v;
  }
  return out;
}

export function validateSavedRequest(value: unknown): SavedRequest {
  if (!isRecord(value)) throw bad('request must be an object');
  const id = value.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('request id must match [A-Za-z0-9_-]{1,64}');
  const name = value.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('request name is required (1-128 chars)');
  const method = value.method;
  if (typeof method !== 'string' || !METHODS.includes(method)) throw bad(`bad request method ${JSON.stringify(method)}`);
  const url = value.url;
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) throw bad('request url is required (max 4096 chars)');
  const headers = validateHeaders(value.headers, 'request');
  let body: string | undefined;
  if (value.body !== undefined) {
    if (typeof value.body !== 'string' || value.body.length > 1_000_000) throw bad('request body must be a string (max 1MB)');
    body = value.body;
  }
  let authProfileId: string | null | undefined;
  if (value.authProfileId !== undefined && value.authProfileId !== null) {
    if (typeof value.authProfileId !== 'string' || !ID_RE.test(value.authProfileId)) throw bad('bad authProfileId');
    authProfileId = value.authProfileId;
  }
  let environment: string | null | undefined;
  if (value.environment !== undefined && value.environment !== null) {
    if (typeof value.environment !== 'string' || !VAR_RE.test(value.environment)) throw bad('bad environment name');
    environment = value.environment;
  }
  return { id, name, method: method as HttpMethod, url, headers, body, authProfileId: authProfileId ?? null, environment: environment ?? null };
}

export function validateCollection(value: unknown): HttpCollection {
  if (!isRecord(value)) throw bad('collection must be an object');
  const id = value.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('collection id must match [A-Za-z0-9_-]{1,64}');
  const name = value.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('collection name is required (1-128 chars)');
  if (!Array.isArray(value.requests)) throw bad('collection requests must be an array');
  if (value.requests.length > MAX_REQUESTS_PER_COLLECTION) throw bad(`too many requests (cap ${MAX_REQUESTS_PER_COLLECTION})`);
  const seen = new Set<string>();
  const requests = value.requests.map((r) => {
    const req = validateSavedRequest(r);
    if (seen.has(req.id)) throw bad(`duplicate request id ${req.id}`);
    seen.add(req.id);
    return req;
  });
  return { id, name, requests };
}

export function validateAuthProfile(value: unknown): {
  id: string;
  name: string;
  kind: AuthKind;
  username?: string;
  headerName?: string;
  secretEnv?: string;
} {
  if (!isRecord(value)) throw bad('auth profile must be an object');
  const id = value.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('auth profile id must match [A-Za-z0-9_-]{1,64}');
  const name = value.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('auth profile name is required (1-128 chars)');
  const kind = value.kind;
  if (kind !== 'bearer' && kind !== 'basic' && kind !== 'apikey' && kind !== 'oauth2') {
    throw bad(`bad auth kind ${JSON.stringify(kind)}`);
  }
  const out: { id: string; name: string; kind: AuthKind; username?: string; headerName?: string; secretEnv?: string } = {
    id,
    name,
    kind,
  };
  if (kind === 'basic') {
    if (typeof value.username !== 'string' || value.username.length === 0 || value.username.length > 256) {
      throw bad('basic auth requires a username');
    }
    out.username = value.username;
  }
  if (kind === 'apikey') {
    if (value.headerName !== undefined) {
      if (typeof value.headerName !== 'string' || !HEADER_RE.test(value.headerName)) throw bad('bad apikey headerName');
      out.headerName = value.headerName;
    }
  }
  if (value.secretEnv !== undefined && value.secretEnv !== null) {
    if (typeof value.secretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.secretEnv)) {
      throw bad('bad secretEnv name');
    }
    out.secretEnv = value.secretEnv;
  }
  return out;
}

export function validateApiEnvironment(value: unknown): ApiEnvironment {
  if (!isRecord(value)) throw bad('environment must be an object');
  const name = value.name;
  if (typeof name !== 'string' || !VAR_RE.test(name)) throw bad('environment name must match [A-Za-z0-9_.-]{1,64}');
  if (!isRecord(value.vars)) throw bad('environment vars must be an object');
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(value.vars)) {
    if (!VAR_RE.test(k)) throw bad(`bad variable name ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || v.length > 10_000) throw bad(`variable ${JSON.stringify(k)} must be a short string`);
    vars[k] = v;
  }
  if (!Array.isArray(value.secretNames)) throw bad('environment secretNames must be an array');
  const secretNames: string[] = [];
  for (const n of value.secretNames) {
    if (typeof n !== 'string' || !VAR_RE.test(n)) throw bad(`bad secret name ${JSON.stringify(n)}`);
    if (secretNames.includes(n)) throw bad(`duplicate secret name ${n}`);
    secretNames.push(n);
  }
  return { name, vars, secretNames };
}

/**
 * Public view of an environment: secret values are replaced with
 * `<redacted>`; the caller can still see WHICH names are secret.
 * Pass the stored secret values separately — this function never
 * receives them, so it cannot leak them.
 */
export function redactApiEnvironment(env: ApiEnvironment): ApiEnvironment {
  const vars: Record<string, string> = { ...env.vars };
  for (const n of env.secretNames) vars[n] = REDACTED;
  return { name: env.name, vars, secretNames: [...env.secretNames] };
}

/** Strip credential headers from a stored spec (rerun re-applies auth). */
export function stripAuthHeaders(headers: Record<string, string>, apiKeyHeaderNames: string[]): Record<string, string> {
  const blocked = new Set(['authorization', ...apiKeyHeaderNames.map((h) => h.toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
