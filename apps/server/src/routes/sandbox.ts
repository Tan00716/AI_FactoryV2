/**
 * Sandbox mode routes — the OS-enforced tier switch.
 *
 *   GET  /api/sandbox/mode        effective + persisted tier
 *   POST /api/sandbox/mode        { mode, approvalPolicy? } → set persisted tier
 *
 * Every change is audited as SANDBOX_MODE_SET (actor 'human').
 * The env override FACTORY_SANDBOX_MODE wins over the persisted file —
 * the GET response reports both the persisted and the effective mode
 * so the UI never lies about which one is in force. Note that a
 * PROJECT config (.ai-factory/sandbox.json) wins over both; the GET
 * response therefore also reports the resolution order. Per-request
 * effective tiers are resolved in exec/terminal/tool-runner via
 * resolveSandboxMode(cwd).
 *
 * allowDanger can ONLY come from the project config file — it is never
 * exposed here, so neither this API nor an env var can silently enable
 * the danger tier.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET →
 * viewer and POST → operator by default. No auth.ts change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  SANDBOX_APPROVAL_POLICY_ENV,
  SANDBOX_MODE_ENV,
  isApprovalPolicy,
  isSandboxMode,
  sandboxModeStore,
  type ApprovalPolicy,
  type SandboxMode,
  type SandboxModeStore,
} from '../sandbox-modes';

const PREFIX = '/api/sandbox';

/** Module singleton (lazy — mirrors the network route's pattern). */
let store: SandboxModeStore | null = null;

function sandboxStore(): SandboxModeStore {
  if (!store) store = sandboxModeStore();
  return store;
}

/** Re-exported for tests: drop the cached store so the next call re-reads. */
export function resetSandboxRouteStoreForTests(): void {
  store = null;
}

export async function handleSandboxRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/sandbox/mode
  if (method === 'GET' && path === `${PREFIX}/mode`) {
    const persisted = sandboxStore().get();
    const envMode = (process.env[SANDBOX_MODE_ENV] ?? '').trim();
    const envPolicy = (process.env[SANDBOX_APPROVAL_POLICY_ENV] ?? '').trim();
    return ctx.json(res, 200, {
      // Effective mode at store level (a project config may still win
      // per-request; see resolveSandboxMode).
      mode: isSandboxMode(envMode) ? envMode : persisted.mode,
      persistedMode: persisted.mode,
      approvalPolicy: isApprovalPolicy(envPolicy) ? envPolicy : persisted.approvalPolicy,
      persistedApprovalPolicy: persisted.approvalPolicy,
      envForced: envMode.length > 0 || envPolicy.length > 0,
      resolutionOrder: ['project .ai-factory/sandbox.json', 'env FACTORY_SANDBOX_MODE', 'persisted store'],
      updatedAt: persisted.updatedAt,
      updatedBy: persisted.updatedBy,
    }), true;
  }

  // POST /api/sandbox/mode { mode: 'read-only'|'workspace-write'|'danger-full-access', approvalPolicy?: 'on-request'|'never' }
  if (method === 'POST' && path === `${PREFIX}/mode`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const mode = body['mode'] as unknown;
    if (!isSandboxMode(mode)) {
      return ctx.json(res, 400, {
        error: 'mode must be one of: read-only, workspace-write, danger-full-access',
        code: 'INVALID_SANDBOX_MODE',
      }), true;
    }
    let approvalPolicy: ApprovalPolicy = sandboxStore().get().approvalPolicy;
    if (body['approvalPolicy'] !== undefined) {
      if (!isApprovalPolicy(body['approvalPolicy'])) {
        return ctx.json(res, 400, {
          error: 'approvalPolicy must be one of: on-request, never',
          code: 'INVALID_APPROVAL_POLICY',
        }), true;
      }
      approvalPolicy = body['approvalPolicy'] as ApprovalPolicy;
    }
    const next = sandboxStore().set(mode as SandboxMode, approvalPolicy, 'human');
    const envForced = ((process.env[SANDBOX_MODE_ENV] ?? '').trim().length > 0);
    ctx.audit.record('human', 'SANDBOX_MODE_SET', 'sandbox', 'mode', {
      mode: next.mode,
      approvalPolicy: next.approvalPolicy,
      envForced,
    });
    return ctx.json(res, 200, {
      mode: isSandboxMode((process.env[SANDBOX_MODE_ENV] ?? '').trim())
        ? (process.env[SANDBOX_MODE_ENV] ?? '').trim()
        : next.mode,
      persistedMode: next.mode,
      approvalPolicy: next.approvalPolicy,
      envForced,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
    }), true;
  }

  return false;
}
