/**
 * V3-#1: per-install API token rotation (POST /api/auth/rotate).
 *
 * Deliberately imports nothing from ../auth: this route file is imported
 * by server tests straight from src via type-stripping, where an
 * extensionless value import of a sibling module cannot resolve, and
 * tsc forbids `.ts`-suffixed imports inside src. All auth behavior it
 * needs arrives through setter injection from index.ts (the established
 * pattern: setShadowRunStartHook, setExtraCheckerProvider, ...).
 *
 * Semantics:
 *  - Caller must present an admin credential (index.ts enforces this
 *    with requestRole before dispatching here; the handler re-checks
 *    via the injected roleOf callback and answers 403 otherwise).
 *  - A fresh 256-bit token is generated, installed as the single token
 *    in memory (the per-request gate reads the config object, so the
 *    old token stops working immediately — no restart), and, when a
 *    token file is configured, persisted there atomically (tmp+rename)
 *    with mode 0600 so a restart keeps the new token.
 *  - The new token is returned exactly once, to the authenticated admin
 *    caller, over the already-authenticated channel; it is the caller's
 *    job to store it (the desktop main process re-reads the token file
 *    on demand, the renderer re-fetches it through the preload bridge).
 *  - The audit record (TOKEN_ROTATED) names the rotation only — never
 *    any token value, old or new. A failed file write rolls the memory
 *    token back and answers 500, so memory and disk can never disagree.
 *  - In explicit open local mode there is no admin credential, so
 *    rotation is refused (409): restart with a token instead. The
 *    handler never invents a credential state.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ROTATE_PATH = '/api/auth/rotate';
export const TOKEN_ROTATED_ACTION = 'TOKEN_ROTATED';

export interface AuthTokenAuditSink {
  record(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ): unknown;
}

export interface AuthTokenDeps {
  /** Current single-token value (admin credential) or undefined. */
  getSingleToken: () => string | undefined;
  /** Install a new single token in the live auth config. */
  setSingleToken: (token: string) => void;
  /** Role of the caller as resolved by index.ts ('admin' required). */
  callerRole: () => string | null;
  /** Token file path (FACTORY_API_TOKEN_FILE) or undefined. */
  tokenFilePath?: string;
  audit: AuthTokenAuditSink;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Handle POST /api/auth/rotate. Returns true when the request was
 * handled (any status), false when the path/method is not this route.
 */
export function handleAuthTokenRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthTokenDeps,
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'POST' || url.pathname !== ROTATE_PATH) return false;
  if (deps.callerRole() !== 'admin') {
    deps.json(res, 403, { error: 'Forbidden' });
    return true;
  }
  const previous = deps.getSingleToken();
  if (previous === undefined) {
    // Explicit open local mode: no admin credential exists, so there is
    // nothing to rotate from. Restart with a token instead.
    deps.json(res, 409, { error: 'No token configured; restart with a token to rotate' });
    return true;
  }
  const next = generateToken();
  deps.setSingleToken(next);
  if (deps.tokenFilePath) {
    try {
      const tmp = `${deps.tokenFilePath}.tmp-${process.pid}`;
      writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, deps.tokenFilePath);
      chmodSync(deps.tokenFilePath, 0o600);
    } catch {
      deps.setSingleToken(previous);
      deps.json(res, 500, { error: 'Failed to persist rotated token; previous token kept' });
      return true;
    }
  }
  deps.audit.record('admin', TOKEN_ROTATED_ACTION, 'api', ROTATE_PATH, {
    tokenFile: deps.tokenFilePath !== undefined,
  });
  deps.json(res, 200, { rotated: true, token: next });
  return true;
}
