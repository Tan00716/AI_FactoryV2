/**
 * Single-operator API token authentication (sellable checklist B).
 *
 * Until now the API relied on the loopback bind alone: any local process
 * could call every endpoint. This module adds one shared-secret gate with
 * deliberately desktop-friendly semantics:
 *
 *  - Token configured (env FACTORY_API_TOKEN): every /api/* request except
 *    GET /api/health must carry `Authorization: Bearer <token>`. Missing
 *    and wrong tokens are indistinguishable — both get the same 401 body —
 *    and every denial is audited (AUTH_DENIED with method/path/source,
 *    never the presented or configured token).
 *  - No token configured: the API stays open (the local desktop mode spawns
 *    this server on loopback and must not break), the startup log warns
 *    once that authentication is disabled — and binding a non-loopback
 *    host without a token refuses to start (fail-closed: an open API must
 *    never become reachable beyond this machine by accident).
 *
 * Token comparison is constant-time: both sides are hashed to fixed-size
 * SHA-256 digests first, so timingSafeEqual never leaks the configured
 * token's length either.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const API_TOKEN_ENV = 'FACTORY_API_TOKEN';
export const AUTH_DENIED_ACTION = 'AUTH_DENIED';
/** The one endpoint exempt from authentication (liveness probes). */
export const HEALTH_PATH = '/api/health';

/**
 * Read the operator token from the environment. Unset, empty and
 * whitespace-only values all mean "authentication disabled" (undefined).
 */
export function resolveApiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[API_TOKEN_ENV];
  if (raw === undefined) return undefined;
  const token = raw.trim();
  return token.length > 0 ? token : undefined;
}

/** Loopback bind hosts: traffic cannot leave this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost';
}

/**
 * Startup policy, as a pure predicate so it is unit-testable without
 * booting the server: returns a fatal error message when the server must
 * refuse to start, or null when startup may proceed.
 *
 *   token set                  → always OK (any bind host).
 *   no token + loopback host   → OK (open local mode; caller logs a warning).
 *   no token + non-loopback    → refuse: an unauthenticated API would be
 *                                exposed beyond this machine.
 */
export function startupAuthError(host: string, token: string | undefined): string | null {
  if (token) return null;
  if (isLoopbackHost(host)) return null;
  return (
    `[ai-factory] refusing to start: host "${host}" is not loopback but ` +
    `${API_TOKEN_ENV} is not set — the API would be reachable without authentication. ` +
    `Set ${API_TOKEN_ENV} or bind a loopback host (127.0.0.1).`
  );
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time check of an Authorization header against the configured
 * token. Only the `Bearer` scheme is accepted; anything malformed is
 * simply "no match" (the caller answers with the uniform 401).
 */
export function bearerTokenMatches(
  header: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const presented = m[1].trim();
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expectedToken));
}

/**
 * The gate itself, as a pure decision over the request line:
 *   - authentication disabled (no token)          → allow
 *   - path outside /api                           → allow (not an API call)
 *   - GET /api/health                             → allow (liveness exemption)
 *   - Bearer token matches the configured token   → allow
 *   - anything else under /api                    → deny
 */
export function evaluateApiAuth(input: {
  method: string;
  path: string;
  authorization: string | string[] | undefined;
  token: string | undefined;
}): 'allow' | 'deny' {
  if (!input.token) return 'allow';
  if (input.path !== '/api' && !input.path.startsWith('/api/')) return 'allow';
  if (input.method === 'GET' && input.path === HEALTH_PATH) return 'allow';
  return bearerTokenMatches(input.authorization, input.token) ? 'allow' : 'deny';
}

/** Minimal structural view of the AuditLog the middleware writes to. */
export interface AuthAuditSink {
  record(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ): unknown;
}

export interface ApiAuthDeps {
  token: string | undefined;
  audit: AuthAuditSink;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

/**
 * Middleware for the server's single pre-dispatch point. Returns true when
 * the request may proceed to routing; on denial it has already written the
 * uniform 401 and the AUTH_DENIED audit record, and returns false.
 * The audit details carry method, path and remote address only — never the
 * presented header value and never the configured token.
 */
export function enforceApiAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiAuthDeps,
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const decision = evaluateApiAuth({
    method: req.method ?? 'GET',
    path: url.pathname,
    authorization: req.headers.authorization,
    token: deps.token,
  });
  if (decision === 'allow') return true;
  deps.audit.record('anonymous', AUTH_DENIED_ACTION, 'api', url.pathname, {
    method: req.method ?? 'GET',
    path: url.pathname,
    remoteAddress: req.socket?.remoteAddress ?? null,
  });
  deps.json(res, 401, { error: 'Unauthorized' });
  return false;
}
