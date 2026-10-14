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
import { tokenPrefixHash } from '@ai-factory/security';

export const API_TOKEN_ENV = 'FACTORY_API_TOKEN';
export const API_TOKENS_ENV = 'FACTORY_API_TOKENS';
export const AUTH_DENIED_ACTION = 'AUTH_DENIED';
export const RBAC_DENIED_ACTION = 'RBAC_DENIED';
/** The one endpoint exempt from authentication (liveness probes). */
export const HEALTH_PATH = '/api/health';
/** Read-only identity probe: returns the caller's role, never any token. */
export const WHOAMI_PATH = '/api/auth/whoami';

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
  /** Role tokens from FACTORY_API_TOKENS (Batch 15). Absent/empty = the
   *  legacy single-token behavior, byte for byte. */
  roleTokens?: RoleToken[];
  audit: AuthAuditSink;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  /**
   * Advisory-only hooks for the §81 brute-force detector (Batch 42).
   * onAuthDenied fires after the uniform 401 is written; never for the
   * 403 RBAC path (a valid token with a small role is not a brute-force
   * signal). onAuthenticatedAllow fires only when a real credential
   * matched — never for the open mode, the health exemption, or
   * non-/api paths (clearing on those would let an attacker reset
   * their own counter with a GET /api/health).
   * Both are advisory: each call is guarded so a throwing hook can
   * never break the 401 gate or leak into the response.
   */
  onAuthDenied?: (event: ApiAuthDeniedEvent) => void;
  onAuthenticatedAllow?: (event: ApiAuthDeniedEvent) => void;
}

/**
 * The advisory event handed to the brute-force detector hooks.
 * Carries the remote address and a deterministic grouping hash —
 * never any token material (see tokenPrefixHash in
 * @ai-factory/security).
 */
export interface ApiAuthDeniedEvent {
  remoteAddress: string | null;
  tokenPrefixHash: string;
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
  const config: ApiAuthConfig = {
    singleToken: deps.token,
    roleTokens: deps.roleTokens ?? [],
  };
  const access = evaluateApiAccess({
    method: req.method ?? 'GET',
    path: url.pathname,
    authorization: req.headers.authorization,
    config,
  });
  if (access.outcome === 'allow') {
    // Advisory hook (Batch 42): a real credential matched. Fires only
    // here — open mode / health exemption / non-/api paths never clear
    // a brute-force counter (see ApiAuthDeps docs).
    if (deps.onAuthenticatedAllow && access.mode !== 'open' && access.role !== null) {
      fireAuthHook(deps, 'onAuthenticatedAllow', req);
    }
    return true;
  }
  if (access.outcome === 'forbidden') {
    // Authenticated, but the role is too small for this surface. The
    // body stays minimal ({ error } only — no role configuration leaks);
    // the audit may name the role and the requirement, never a token.
    deps.audit.record(access.role ?? 'unknown', RBAC_DENIED_ACTION, 'api', url.pathname, {
      method: req.method ?? 'GET',
      path: url.pathname,
      remoteAddress: req.socket?.remoteAddress ?? null,
      role: access.role,
      requiredRole: access.required,
    });
    deps.json(res, 403, { error: 'Forbidden' });
    return false;
  }
  deps.audit.record('anonymous', AUTH_DENIED_ACTION, 'api', url.pathname, {
    method: req.method ?? 'GET',
    path: url.pathname,
    remoteAddress: req.socket?.remoteAddress ?? null,
  });
  deps.json(res, 401, { error: 'Unauthorized' });
  // Advisory hook (Batch 42): fired AFTER the 401 is written, so a
  // detector bug can never disturb the denial. Guarded — the gate
  // stays bulletproof no matter what the hook does.
  if (deps.onAuthDenied) {
    fireAuthHook(deps, 'onAuthDenied', req);
  }
  return false;
}

/**
 * Invoke one advisory auth hook with the detector event. A throwing
 * hook is audited (AUTH_CALLBACK_FAILED) and swallowed: the 401/allow
 * decision already stands and must never be disturbed by advisory
 * logic. The event carries no token material.
 */
function fireAuthHook(
  deps: ApiAuthDeps,
  hook: 'onAuthDenied' | 'onAuthenticatedAllow',
  req: IncomingMessage,
): void {
  try {
    deps[hook]?.({
      remoteAddress: req.socket?.remoteAddress ?? null,
      tokenPrefixHash: tokenPrefixHash(req.headers.authorization),
    });
  } catch (err) {
    deps.audit.record('system', 'AUTH_CALLBACK_FAILED', 'api', hook, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ------------------------------------------------------------ RBAC (Batch 15)

/**
 * Role-based access control layered on the token gate.
 *
 * Roles (ascending privilege):
 *   viewer   — read-only: GET endpoints.
 *   operator — daily work: tasks, evidence, transitions, runs, approvals.
 *   admin    — dangerous management surfaces: backup/restore, retention
 *              policies/holds/enforce, legal holds, policy changes.
 *
 * Configuration (FACTORY_API_TOKENS): comma-separated `role:token`
 * entries, e.g.
 *   FACTORY_API_TOKENS="viewer:view-secret,operator:op-secret,admin:admin-secret"
 * A token may itself contain ':' (only the first colon separates the
 * role). Several tokens may share a role; one token string may not map
 * to two roles (ambiguous → startup error). Malformed entries are a
 * fatal startup error — never silently ignored (fail-closed).
 *
 * Backward compatibility (hard requirement):
 *   - FACTORY_API_TOKENS unset → behavior is exactly the pre-RBAC gate:
 *     the single FACTORY_API_TOKEN (when set) is an admin credential,
 *     and with neither variable set on a loopback bind the API stays
 *     open (local single-machine mode, effective role admin).
 *   - FACTORY_API_TOKEN, when set, always remains valid as admin, even
 *     alongside FACTORY_API_TOKENS.
 */
export type ApiRole = 'viewer' | 'operator' | 'admin';

export const ROLE_RANK: Record<ApiRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleRank(role: ApiRole): number {
  return ROLE_RANK[role];
}

export interface RoleToken {
  role: ApiRole;
  token: string;
}

/** The full credential configuration the gate decides over. */
export interface ApiAuthConfig {
  /** Legacy single token (FACTORY_API_TOKEN) — an admin credential. */
  singleToken: string | undefined;
  /** Role tokens (FACTORY_API_TOKENS). */
  roleTokens: RoleToken[];
}

export type AuthMode = 'open' | 'single' | 'rbac';

export function authMode(config: ApiAuthConfig): AuthMode {
  if (config.roleTokens.length > 0) return 'rbac';
  return config.singleToken ? 'single' : 'open';
}

export function hasAnyCredential(config: ApiAuthConfig): boolean {
  return config.singleToken !== undefined || config.roleTokens.length > 0;
}

const ROLE_NAMES: readonly string[] = ['viewer', 'operator', 'admin'];

function isApiRole(value: string): value is ApiRole {
  return ROLE_NAMES.includes(value);
}

/**
 * Parse the FACTORY_API_TOKENS value. Errors describe the entry position
 * and the problem only — a token value is never echoed into an error.
 */
export function parseRoleTokens(raw: string | undefined): {
  entries: RoleToken[];
  errors: string[];
} {
  const entries: RoleToken[] = [];
  const errors: string[] = [];
  if (raw === undefined) return { entries, errors };
  const seen = new Map<string, ApiRole>();
  const parts = raw.split(',');
  parts.forEach((part, i) => {
    const entry = part.trim();
    if (entry === '') return; // tolerate stray commas / trailing comma
    const label = `entry ${i + 1}`;
    const colon = entry.indexOf(':');
    if (colon < 0) {
      errors.push(`${label}: expected "role:token"`);
      return;
    }
    const roleRaw = entry.slice(0, colon).trim().toLowerCase();
    const token = entry.slice(colon + 1).trim();
    if (!isApiRole(roleRaw)) {
      errors.push(`${label}: unknown role "${roleRaw}" (expected viewer, operator or admin)`);
      return;
    }
    if (token === '') {
      errors.push(`${label}: empty token for role "${roleRaw}"`);
      return;
    }
    const previous = seen.get(token);
    if (previous !== undefined) {
      errors.push(
        previous === roleRaw
          ? `${label}: duplicate token for role "${roleRaw}"`
          : `${label}: the same token is assigned to both "${previous}" and "${roleRaw}"`,
      );
      return;
    }
    seen.set(token, roleRaw);
    entries.push({ role: roleRaw, token });
  });
  return { entries, errors };
}

/** Resolve the full auth configuration from the environment. */
export function resolveApiAuthConfig(env: NodeJS.ProcessEnv = process.env): {
  config: ApiAuthConfig;
  errors: string[];
} {
  const parsed = parseRoleTokens(env[API_TOKENS_ENV]);
  return {
    config: { singleToken: resolveApiToken(env), roleTokens: parsed.entries },
    errors: parsed.errors,
  };
}

/**
 * Startup policy for the RBAC configuration (companion to
 * startupAuthError, which keeps its single-token contract): any
 * credential — the single token or at least one role token — makes any
 * bind host acceptable; no credential at all keeps the loopback-only
 * rule. Malformed FACTORY_API_TOKENS entries are named by the caller as
 * a separate fatal error (see parseRoleTokens).
 */
export function startupRbacError(host: string, config: ApiAuthConfig): string | null {
  if (hasAnyCredential(config)) return null;
  if (isLoopbackHost(host)) return null;
  return (
    `[ai-factory] refusing to start: host "${host}" is not loopback but neither ` +
    `${API_TOKEN_ENV} nor ${API_TOKENS_ENV} is set — the API would be reachable ` +
    `without authentication. Set one of them or bind a loopback host (127.0.0.1).`
  );
}

/**
 * Which configured credential does this Authorization header present?
 * Returns its role, or null when nothing matches. Every configured
 * credential is compared (constant-time per credential) and the match
 * is remembered rather than returned early, so the number of configured
 * tokens is not trivially oracle-able through timing.
 */
export function roleForAuthorization(
  header: string | string[] | undefined,
  config: ApiAuthConfig,
): ApiRole | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const presented = m[1].trim();
  if (!presented) return null;
  const presentedDigest = digest(presented);
  let matched: ApiRole | null = null;
  if (config.singleToken) {
    if (timingSafeEqual(presentedDigest, digest(config.singleToken))) matched = 'admin';
  }
  for (const entry of config.roleTokens) {
    if (timingSafeEqual(presentedDigest, digest(entry.token))) matched = entry.role;
  }
  return matched;
}

/**
 * Minimum role a route requires, or null when the path sits outside the
 * gate entirely (non-/api) or is the public health probe. The
 * classification is by surface, not by route file:
 *   - the backup surface (/api/backup, /api/restore, /api/backups) is
 *     admin, reads included — a backup inventory names snapshot ids and
 *     timestamps;
 *   - retention: reads are viewer; every mutation (policies PUT, holds
 *     POST/release, evaluate, enforce) is admin;
 *   - policy: reads are viewer; POST /api/policy/validate is a pure
 *     computation (operator); any other policy write is admin;
 *   - PUT /api/autonomy/mode sets a project's autonomy tier — a policy
 *     decision, admin;
 *   - every other GET is viewer; every other write is operator.
 */
export function requiredRoleFor(method: string, path: string): ApiRole | null {
  if (path !== '/api' && !path.startsWith('/api/')) return null;
  if (method === 'GET' && path === HEALTH_PATH) return null;
  if (path === '/api/backup' && method === 'POST') return 'admin';
  if (path === '/api/restore' && method === 'POST') return 'admin';
  if (path === '/api/backups' || path.startsWith('/api/backups/')) return 'admin';
  // Backup schedules (§47, Batch 20): creating a schedule creates
  // backups on a timer — admin, like the backup surface itself.
  if (path === '/api/backup/schedules' || path.startsWith('/api/backup/schedules/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  if (path === '/api/retention' || path.startsWith('/api/retention/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  if (path.startsWith('/api/policy/')) {
    if (method === 'GET') return 'viewer';
    if (method === 'POST' && path === '/api/policy/validate') return 'operator';
    return 'admin';
  }
  if (path === '/api/autonomy/mode' && method !== 'GET') return 'admin';
  // Secret Broker (§46.2): metadata reads are viewer (names/purpose/
  // status only — values are never served over HTTP at all); every
  // mutation is admin, like the other credential-adjacent surfaces.
  if (path === '/api/secrets' || path.startsWith('/api/secrets/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  // Authorization tickets (§17.2, Batch 18): issuing or revoking a
  // pre-authorization ticket is policy administration — admin;
  // reads are viewer, like the other policy surfaces above.
  if (path === '/api/authorization-tickets' || path.startsWith('/api/authorization-tickets/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  // MCP stdio launch with secret injection (Batch 19, §46.2):
  // spawning a child process with credential values is
  // credential-adjacent — admin, like the secret mutations above.
  // Reads of the launch table and redacted logs are viewer.
  if (path === '/api/mcp/launch' && method === 'POST') return 'admin';
  if (path.startsWith('/api/mcp/launches/') && path.endsWith('/stop') && method === 'POST') return 'admin';
  if ((path === '/api/mcp/launches' || path.startsWith('/api/mcp/launches/')) && method === 'GET') return 'viewer';
  // MCP trust flow (§46, Batch 20): reading a trust evaluation is
  // viewer, like the other metadata surfaces; approving, denying or
  // revoking trust changes whether code may execute — admin.
  if (path.startsWith('/api/mcp/servers/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  // Database broker (§33, Batch 29): executing queries is operator
  // work; connection registration and privilege-policy writes are
  // admin (the whitelist is the only control between an operator and
  // the tables). Reads of connections/policies/templates are viewer.
  if (path === '/api/db/connections' && method === 'POST') return 'admin';
  if (path.startsWith('/api/db/connections/')) {
    if (method === 'DELETE') return 'admin';
    if (method === 'PUT') return 'admin';
    return method === 'GET' ? 'viewer' : 'operator';
  }
  if (path === '/api/db/runbooks' && method === 'POST') return 'admin';
  // Builds read surface (§40, Batch 31): the builds table is a read-only
  // observation surface — no writable endpoint exists under /api/builds
  // (the handler answers 405 for non-GET). GETs are viewer, like the
  // other metadata surfaces; non-GET stays admin so a write-like call
  // can never ride on a weaker role.
  if (path === '/api/builds' || path.startsWith('/api/builds/')) {
    return method === 'GET' ? 'viewer' : 'admin';
  }
  // Audit chain verification (§32, Batch 53): verifying the chain is an
  // operator control action, not passive metadata reading — viewer does
  // not get it. The endpoint always verifies the FULL chain anchored at
  // genesis; pagination is refused, not silently truncated (F33).
  if (path === '/api/audit/verify') return 'operator';
  return method === 'GET' ? 'viewer' : 'operator';
}

export interface ApiAccess {
  outcome: 'allow' | 'unauthenticated' | 'forbidden';
  /** The caller's resolved role (null when unauthenticated). */
  role: ApiRole | null;
  /** The role the route required (null outside the gate / public). */
  required: ApiRole | null;
  mode: AuthMode;
}

/**
 * The full gate decision. With no role tokens configured this reduces
 * to evaluateApiAuth's outcomes exactly (single token = admin, open
 * mode = allow), which is what keeps the pre-RBAC behavior identical.
 */
export function evaluateApiAccess(input: {
  method: string;
  path: string;
  authorization: string | string[] | undefined;
  config: ApiAuthConfig;
}): ApiAccess {
  const mode = authMode(input.config);
  const required = requiredRoleFor(input.method, input.path);
  if (required === null) return { outcome: 'allow', role: null, required: null, mode };
  if (mode === 'open') return { outcome: 'allow', role: 'admin', required, mode };
  const role = roleForAuthorization(input.authorization, input.config);
  if (role === null) return { outcome: 'unauthenticated', role: null, required, mode };
  return roleRank(role) >= roleRank(required)
    ? { outcome: 'allow', role, required, mode }
    : { outcome: 'forbidden', role, required, mode };
}

/**
 * The caller's identity for GET /api/auth/whoami: their role and the
 * auth mode — never any token. In open (local) mode the effective role
 * is admin and mode says so, so a client can honestly render "local
 * mode" instead of inventing a credential state.
 */
export function requestRole(
  req: IncomingMessage,
  config: ApiAuthConfig,
): { role: ApiRole | null; mode: AuthMode; authRequired: boolean } {
  const mode = authMode(config);
  if (mode === 'open') return { role: 'admin', mode, authRequired: false };
  return {
    role: roleForAuthorization(req.headers.authorization, config),
    mode,
    authRequired: true,
  };
}
