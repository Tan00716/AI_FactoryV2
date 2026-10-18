/**
 * @ai-factory/mcp — OAuth 2.1 authorization-code flow for remote MCP servers.
 *
 * Implements the client side of RFC 6749 / RFC 7636 (PKCE) / RFC 8414
 * (authorization-server metadata discovery) / RFC 9207 (request
 * authorization `iss` check), scoped to what a remote MCP integration
 * needs:
 *
 *   1. discoverOAuthMetadata(issuer) — fetch the RFC 8414 well-known
 *      document to learn the authorization/token endpoints.
 *   2. fetchClientIdMetadataDocument(url) — Client ID Metadata Document
 *      (MCP 2026-07-28; Dynamic Client Registration is deprecated):
 *      the document URL itself is the client_id.
 *   3. buildAuthorizationUrl(...)     — PKCE S256 + state; the operator
 *      opens this in a browser.
 *   4. validateAuthorizationResponseIss(...) — RFC 9207: the `iss`
 *      parameter on the authorization response must match the issuer.
 *   5. exchangeCodeForToken(...)      — the callback code becomes
 *      tokens (POST, form-urlencoded).
 *   6. refreshAccessToken(...)        — refresh_token grant.
 *   7. OAuthTokenManager              — expiry-aware access-token
 *      supply backed by an OAuthTokenStore (the app server wires the
 *      secrets-backed store; this package never sees a vault).
 *   8. tokenClaimsForGate(...)        — decode JWT claims and feed
 *      them into the existing evaluateOAuth() audience/scope check,
 *      so the §34.3 gate enforces REAL token claims instead of
 *      caller-asserted ones.
 *   9. oauthStoreKey(...)             — issuer-scoped vault key
 *      derivation: credentials are NEVER shared across issuers.
 *
 * Zero external dependencies — node:crypto + node:http(s) only.
 *
 * Honest boundaries (stated, not hidden):
 *  - This is the CLIENT side. Token signature verification happens on
 *    the RESOURCE server (the MCP server); a client cannot verify an
 *    access token's signature without the issuer's keys. What this
 *    module does verify for real: PKCE binding (code_verifier), the
 *    `state` round-trip (CSRF), token-endpoint TLS (https except
 *    loopback, RFC 8252 §7.3), and the JWT `aud`/`scope` claims
 *    against the §34.3 policy before a call is attempted.
 *  - Opaque (non-JWT) access tokens carry no client-readable claims;
 *    tokenClaimsForGate() reports that plainly and lets the call
 *    through — enforcement then rests with the remote server, which
 *    is the only party that can check an opaque token.
 *  - Client secrets are passed through, never logged, never stored
 *    here; storage is the OAuthTokenStore's job.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { McpRuntimePolicy } from './types';
import { evaluateOAuth, type PolicyVerdict } from './runtimePolicy';
import { doHttpRequest, isLoopbackUrl } from './http-transport';

/* ---------------------------------------------------------- types -- */

export interface OAuthClientConfig {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId: string;
  /** confidential clients only — passed through, never logged */
  clientSecret?: string;
  scopes: string[];
  redirectUri: string;
}

export interface PkcePair {
  /** high-entropy secret sent to the token endpoint later */
  verifier: string;
  /** S256 challenge sent to the authorization endpoint now */
  challenge: string;
}

export interface AuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  /** RFC 8707 — bind the grant to the MCP server as the resource */
  resource?: string;
}

export interface TokenExchangeParams {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
}

export interface RefreshParams {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
}

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** ms epoch when the token was obtained */
  obtainedAt: number;
  /** seconds until expiry, when the server reported it */
  expiresIn?: number;
}

/** Pluggable token persistence — the app server implements this on the secrets vault. */
export interface OAuthTokenStore {
  save(key: string, token: StoredOAuthToken): Promise<void>;
  load(key: string): Promise<StoredOAuthToken | null>;
  clear(key: string): Promise<void>;
}

export interface OAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  [k: string]: unknown;
}

/** A Client ID Metadata Document (MCP 2026-07-28 — DCR is deprecated). */
export interface ClientIdMetadataDocument {
  /** the document URL itself is the client_id */
  clientId: string;
  redirectUris: string[];
  [k: string]: unknown;
}

/**
 * Fetch and validate a Client ID Metadata Document. The document URL
 * becomes the client_id sent to the authorization server; its
 * `redirect_uris` MUST contain the redirect URI we will use.
 */
export async function fetchClientIdMetadataDocument(url: string, timeoutMs = 10_000): Promise<ClientIdMetadataDocument> {
  assertTls(url, 'client ID metadata document');
  const res = await doHttpRequest(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  if (res.status !== 200) {
    throw new Error(`oauth: client ID metadata document fetch failed with HTTP ${res.status} at ${url}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error('oauth: client ID metadata document is not JSON');
  }
  const d = doc as Record<string, unknown>;
  const redirectUris = Array.isArray(d.redirect_uris)
    ? d.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  if (!redirectUris.length) {
    throw new Error('oauth: client ID metadata document has no redirect_uris');
  }
  return { clientId: url, redirectUris, ...d };
}

/**
 * Resolve the client_id for the authorization request. With a Client
 * ID Metadata Document configured, the document URL is the client_id
 * and the redirect URI must be listed in it; otherwise the configured
 * static clientId is used (public client, PKCE-only).
 */
export async function resolveClientId(
  cfg: { clientId: string; clientIdMetadataUrl?: string },
  redirectUri: string,
): Promise<string> {
  if (cfg.clientIdMetadataUrl) {
    const doc = await fetchClientIdMetadataDocument(cfg.clientIdMetadataUrl);
    if (!doc.redirectUris.includes(redirectUri)) {
      throw new Error(
        `oauth: redirect URI '${redirectUri}' is not listed in the client ID metadata document's redirect_uris`,
      );
    }
    return doc.clientId;
  }
  if (!cfg.clientId) throw new Error('oauth: clientId is required (or configure clientIdMetadataUrl)');
  return cfg.clientId;
}

/**
 * RFC 9207: when the authorization server returns an `iss` parameter
 * on the authorization response, it MUST exactly match the issuer
 * the client used for discovery. A mismatch means the response came
 * from (or was tampered toward) a different issuer — refuse it.
 * Absent `iss` is allowed (not all servers send it) and passes.
 */
export function validateAuthorizationResponseIss(expectedIssuer: string, receivedIss: string | null): void {
  if (receivedIss === null || receivedIss === undefined || receivedIss === '') return;
  const norm = (s: string) => s.replace(/\/+$/, '');
  if (norm(receivedIss) !== norm(expectedIssuer)) {
    throw new Error(
      `oauth: authorization response iss mismatch (RFC 9207): got '${receivedIss}', expected '${expectedIssuer}'`,
    );
  }
}

/**
 * Issuer-scoped store-key derivation. Credentials are keyed by
 * (server, issuer) and NEVER shared across issuers: a token minted
 * by issuer A is unusable/unreadable for issuer B, even for the same
 * MCP server name. The issuer identity string is hashed so the raw
 * issuer URL never becomes part of the vault name.
 */
export function oauthStoreKey(serverName: string, serverVersion: string, issuerRef: string): string {
  // Vault-safe: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ (see @ai-factory/secrets).
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 48) || 'x';
  const digest = createHash('sha256').update(issuerRef, 'utf8').digest('hex').slice(0, 16);
  return `mcp-oauth-${clean(serverName)}-${clean(serverVersion)}-${digest}`;
}

/* ----------------------------------------------------------- PKCE -- */

/** Generate a PKCE pair: 32 random bytes, S256 challenge, base64url. */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

/** 32 random bytes, hex — for `state` (CSRF protection). */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time state comparison for the callback round-trip. */
export function statesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------- authorization -- */

/** Build the URL the operator opens in a browser to start the grant. */
export function buildAuthorizationUrl(p: AuthorizationUrlParams): string {
  if (!p.authorizationEndpoint || !p.clientId || !p.redirectUri || !p.state || !p.codeChallenge) {
    throw new Error('oauth: authorizationEndpoint, clientId, redirectUri, state and codeChallenge are required');
  }
  assertTls(p.authorizationEndpoint, 'authorization endpoint');
  const u = new URL(p.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  if (p.scopes.length) u.searchParams.set('scope', p.scopes.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.resource) u.searchParams.set('resource', p.resource);
  return u.toString();
}

/**
 * RFC 8414 discovery: fetch `{issuer}/.well-known/oauth-authorization-server`.
 * The issuer MUST be https (loopback http allowed for local dev).
 */
export async function discoverOAuthMetadata(issuer: string, timeoutMs = 10_000): Promise<OAuthMetadata> {
  assertTls(issuer, 'issuer');
  const base = issuer.replace(/\/+$/, '');
  const url = `${base}/.well-known/oauth-authorization-server`;
  const res = await doHttpRequest(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  if (res.status !== 200) {
    throw new Error(`oauth: metadata discovery failed with HTTP ${res.status} at ${url}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error('oauth: metadata discovery returned non-JSON');
  }
  const d = doc as Record<string, unknown>;
  const authorizationEndpoint = typeof d.authorization_endpoint === 'string' ? d.authorization_endpoint : '';
  const tokenEndpoint = typeof d.token_endpoint === 'string' ? d.token_endpoint : '';
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('oauth: metadata document lacks authorization_endpoint/token_endpoint');
  }
  return { issuer: typeof d.issuer === 'string' ? d.issuer : issuer, authorizationEndpoint, tokenEndpoint, ...d };
}

/* ------------------------------------------------------ token I/O -- */

function formBody(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

/** Extract the server's error detail (if any) from a non-200 token response body. */
function oauthErrorDetail(body: Buffer): string {
  try {
    const o = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof o.error === 'string') {
      const desc = typeof o.error_description === 'string' ? `: ${o.error_description}` : '';
      return ` (${o.error}${desc})`;
    }
  } catch {
    /* not JSON — no detail available */
  }
  return '';
}

function parseTokenResponse(body: string, what: string): OAuthTokenResponse {
  let d: unknown;
  try {
    d = JSON.parse(body);
  } catch {
    throw new Error(`oauth: ${what} returned non-JSON`);
  }
  const o = d as Record<string, unknown>;
  if (typeof o.error === 'string') {
    const desc = typeof o.error_description === 'string' ? `: ${o.error_description}` : '';
    throw new Error(`oauth: ${what} failed (${o.error}${desc})`);
  }
  if (typeof o.access_token !== 'string' || !o.access_token) {
    throw new Error(`oauth: ${what} response has no access_token`);
  }
  return {
    accessToken: o.access_token,
    tokenType: typeof o.token_type === 'string' ? o.token_type : 'Bearer',
    expiresIn: typeof o.expires_in === 'number' ? o.expires_in : undefined,
    refreshToken: typeof o.refresh_token === 'string' ? o.refresh_token : undefined,
    scope: typeof o.scope === 'string' ? o.scope : undefined,
  };
}

/** Exchange the callback `code` for tokens (authorization_code grant). */
export async function exchangeCodeForToken(p: TokenExchangeParams, timeoutMs = 15_000): Promise<OAuthTokenResponse> {
  assertTls(p.tokenEndpoint, 'token endpoint');
  const res = await doHttpRequest(p.tokenEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json' },
    textBody: formBody({
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.codeVerifier,
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      ...(p.clientSecret !== undefined ? { client_secret: p.clientSecret } : {}),
    }),
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  // The body replaces the headers object so the secret never lingers.
  if (res.status !== 200) {
    throw new Error(`oauth: code exchange failed with HTTP ${res.status}${oauthErrorDetail(res.body)}`);
  }
  return parseTokenResponse(res.body.toString('utf8'), 'code exchange');
}

/** Use a refresh token to mint a new access token. */
export async function refreshAccessToken(p: RefreshParams, timeoutMs = 15_000): Promise<OAuthTokenResponse> {
  assertTls(p.tokenEndpoint, 'token endpoint');
  const res = await doHttpRequest(p.tokenEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json' },
    textBody: formBody({
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      ...(p.clientSecret !== undefined ? { client_secret: p.clientSecret } : {}),
      ...(p.scopes?.length ? { scope: p.scopes.join(' ') } : {}),
    }),
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  if (res.status !== 200) {
    throw new Error(`oauth: refresh failed with HTTP ${res.status}${oauthErrorDetail(res.body)}`);
  }
  return parseTokenResponse(res.body.toString('utf8'), 'token refresh');
}

/* ------------------------------------------------- token manager -- */

const EXPIRY_SKEW_MS = 60_000;

export function isTokenExpired(t: StoredOAuthToken, now: number = Date.now()): boolean {
  if (t.expiresIn === undefined) return false; // no expiry reported — treat as valid until a 401 says otherwise
  return t.obtainedAt + t.expiresIn * 1000 - EXPIRY_SKEW_MS <= now;
}

export function toStoredToken(resp: OAuthTokenResponse, now: number = Date.now()): StoredOAuthToken {
  return {
    accessToken: resp.accessToken,
    refreshToken: resp.refreshToken,
    tokenType: resp.tokenType,
    scope: resp.scope,
    obtainedAt: now,
    expiresIn: resp.expiresIn,
  };
}

export interface TokenClientIdentity {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
}

/**
 * Expiry-aware access-token supply. Returns a usable access token,
 * refreshing transparently when the stored one is expired and a
 * refresh token exists. Throws when no token is stored (the caller
 * should start the authorization flow) or the refresh fails.
 */
export class OAuthTokenManager {
  async getValidAccessToken(
    key: string,
    client: TokenClientIdentity,
    store: OAuthTokenStore,
    now: number = Date.now(),
  ): Promise<string> {
    const stored = await store.load(key);
    if (!stored) {
      throw new Error(`oauth: no token stored for '${key}' — run the authorization flow first`);
    }
    if (!isTokenExpired(stored, now)) return stored.accessToken;
    if (!stored.refreshToken) {
      throw new Error(`oauth: stored token for '${key}' is expired and has no refresh token — re-authorize`);
    }
    const refreshed = await refreshAccessToken({
      tokenEndpoint: client.tokenEndpoint,
      refreshToken: stored.refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    });
    const next: StoredOAuthToken = {
      ...toStoredToken(refreshed, now),
      // Some servers only return a refresh token on the first grant;
      // keep the old one when the refresh response omits it.
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    };
    await store.save(key, next);
    return next.accessToken;
  }

  async saveTokenResponse(key: string, resp: OAuthTokenResponse, store: OAuthTokenStore, now: number = Date.now()): Promise<void> {
    await store.save(key, toStoredToken(resp, now));
  }

  async clear(key: string, store: OAuthTokenStore): Promise<void> {
    await store.clear(key);
  }
}

/* --------------------------------------- claims → §34.3 gate check -- */

export interface DecodedTokenClaims {
  audience?: string;
  scopes: string[];
  /** false when the token is opaque (no client-readable claims) */
  isJwt: boolean;
}

/**
 * Best-effort JWT payload decode (no signature verification — that is
 * the resource server's job, stated plainly). Returns null when the
 * token is not a JWT at all.
 */
export function decodeJwtClaims(accessToken: string): DecodedTokenClaims | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const aud = payload.aud;
    const audience =
      typeof aud === 'string' ? aud : Array.isArray(aud) && typeof aud[0] === 'string' ? aud[0] : undefined;
    const scopeRaw = payload.scope;
    const scopes =
      typeof scopeRaw === 'string'
        ? scopeRaw.split(' ').filter(Boolean)
        : Array.isArray(payload.scp)
          ? (payload.scp as unknown[]).filter((s): s is string => typeof s === 'string')
          : [];
    return { audience, scopes, isJwt: true };
  } catch {
    return null;
  }
}

/**
 * Wire REAL token claims into the §34.3 gate: decode the JWT and run
 * the policy's audience/scope expectations against what the token
 * actually carries (not caller-asserted values). Opaque tokens are
 * reported honestly — enforcement rests with the remote server.
 */
export function tokenClaimsForGate(
  policy: McpRuntimePolicy,
  accessToken: string,
): PolicyVerdict & { claims: DecodedTokenClaims | null } {
  const claims = decodeJwtClaims(accessToken);
  if (!claims) {
    return {
      allowed: true,
      reason: 'ok (opaque access token — audience/scope are enforced by the remote server)',
      claims: null,
    };
  }
  const verdict = evaluateOAuth(policy, { audience: claims.audience, scopes: claims.scopes });
  return { ...verdict, claims };
}

/* ---------------------------------------------------------- guard -- */

/**
 * Token/authorization endpoints MUST be https, except loopback http
 * for local development (RFC 8252 §7.3). Anything else is refused.
 */
function assertTls(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`oauth: unparseable ${what} '${url}'`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopbackUrl(url)) return;
  throw new Error(`oauth: refusing non-TLS ${what} '${url}' (https required, loopback http allowed)`);
}
