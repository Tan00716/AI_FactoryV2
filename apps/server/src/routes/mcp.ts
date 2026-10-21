/**
 * MCP routes — spec §46 (MCP Registry), §73 (MCP Security).
 *
 *   GET  /api/mcp                        list registered servers + install status
 *   POST /api/mcp/register               {server: McpServerDefinition}
 *   POST /api/mcp/install                {name, version, requestedBy?}
 *   POST /api/mcp/review                 {name, version, approved, reviewer?, reason?}
 *   POST /api/mcp/remove                 {name, version}
 *   POST /api/mcp/gate                   {server, version?, tool, agentId?, taskId?, callerPermissions?}
 *   GET  /api/mcp/usage?server=
 *   POST /api/mcp/launch                {name, version} (+command/args/cwd/secretEnv); name and version are required (400 otherwise)
 *   GET  /api/mcp/servers/:id/trust            trust evaluation query
 *   POST /api/mcp/servers/:id/trust/approve    BLOCKED -> policy (admin)
 *   POST /api/mcp/servers/:id/trust/deny       record a denial, stays BLOCKED (admin)
 *   POST /api/mcp/servers/:id/trust/revoke     policy -> BLOCKED + uninstall + stop running (admin)
 *
 * Unknown sources default to BLOCKED (§73). An install that needs review
 * returns 202 with the pending-review descriptor; re-issue /review after
 * a human (or AI reviewer) decides. Every install/review/remove/gate/trust
 * call writes an audit record.
 *
 * Trust flow (Batch 20, §46): the trustLevel/approvalPolicy state and
 * McpManager.assessTrust live in @ai-factory/mcp; the HTTP state machine
 * here is the route layer's — approving, denying or revoking trust is
 * admin-only, illegal transitions are 409, and the launch endpoint
 * refuses BLOCKED servers with a pointer to /trust/approve instead of
 * a dead end (that dead end was a KNOWN_LIMITATIONS entry until now).
 *
 * The coordinator wires this in: handleMcpRoutes(req, res, url, ctx).
 * Durability (Batch 21): registrations, trust/assessments and install
 * records are written through to fdb.mcpServers and hydrated at
 * startup (see initMcpPersistence / mcp-persistence.ts). Launch
 * RECORDS are also persisted (Batch 26): the live process table is
 * still process-local, but every spawn/stop/exit lands a row, and a
 * restart marks other boots' still-RUNNING rows ORPHANED (child fate
 * unknown, not managed) instead of forgetting them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  McpRegistry,
  McpManager,
  ToolCallGate,
  withBoundedRetry,
  StreamableMcpConnector,
  OAuthTokenManager,
  buildAuthorizationUrl,
  generatePkcePair,
  generateState,
  statesEqual,
  exchangeCodeForToken,
  discoverOAuthMetadata,
  decodeJwtClaims,
  resolveClientId,
  validateAuthorizationResponseIss,
  type McpServerDefinition,
  type StatelessMcpConnector,
  type McpServer,
} from '@ai-factory/mcp';
import type { RouteContext } from './context';
import type { FactoryDatabase, McpServerStore } from '@ai-factory/db';
import { McpServerLauncher, McpLaunchError } from '../mcp-launcher';
import { recordRedactionHit } from '../redaction-monitor';
import { SecretsBackedOAuthTokenStore, oauthSecretName } from '../mcp-oauth-store';
import { readServerModeFlag, writeServerModeFlag } from '../mcp-server-mode';
import {
  hydrateMcpRegistry,
  attachMcpPersistence,
  removeMcpServerRecord,
  hydrateMcpLaunches,
  attachLaunchPersistence,
  newMcpBootId,
} from '../mcp-persistence';
import { NETWORK_OFFLINE_CODE, networkMode } from '../network-mode';
import { assertEgressAllowed, EGRESS_BLOCKED_CODE } from '../egress';

const PREFIX = '/api/mcp';

const registry = new McpRegistry();
const manager = new McpManager(registry);
const gate = new ToolCallGate({ registry, manager });

/** W-F: plugin routes register/unregister capability servers through this registry. */
export function getMcpRegistry(): McpRegistry {
  return registry;
}
// Process table for launched stdio MCP servers. One instance per
// process — launches die with the server, and that is stated in
// KNOWN_LIMITATIONS (same honesty as the merge queue / PrStore).
const launcher = new McpServerLauncher();

// W-A — remote (sse/http) connectors, one per connected server. Created
// by POST /api/mcp/remote/connect, reused by /api/mcp/remote/call.
// Process-local like the stdio launch table: a restart drops them and
// the panel reconnects (the registry records persist).
const remoteConnectors = new Map<string, { connector: StatelessMcpConnector; server: McpServer }>();

// W-A — in-flight OAuth authorization flows: state → PKCE + identity.
// Entries expire after 10 minutes; the callback validates `state` with
// a constant-time comparison and `iss` per RFC 9207 before any token
// is exchanged.
const oauthPending = new Map<string, {
  name: string;
  version: string;
  verifier: string;
  redirectUri: string;
  /** issuer used for RFC 8414 discovery — the callback's `iss` must match (RFC 9207) */
  issuer: string;
  createdAt: number;
}>();

const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

function remoteKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Durable registry backing (§46, Batch 21). Set once at server
 * startup by initMcpPersistence(); null in tests that drive the
 * routes without a database.
 */
let mcpStore: McpServerStore | null = null;

/**
 * This server boot's id (Batch 26). Launch rows carry it so hydration
 * can distinguish "mine" from "a previous boot's" and mark the
 * latter ORPHANED instead of forgetting them.
 */
const mcpBootId = newMcpBootId();

/**
 * Server startup: replay persisted registrations/trust/installs into
 * the in-memory registry+manager (no new history/audit events — this
 * is learning, not re-doing), mark other boots' still-RUNNING launch
 * rows ORPHANED, then attach the write-through observers so every
 * later mutation lands in the DB.
 */
export function initMcpPersistence(fdb: FactoryDatabase): {
  restoredServers: number;
  restoredInstalls: number;
  staleHealthMarked: number;
  orphanedLaunches: number;
} {
  mcpStore = fdb.mcpServers;
  const result = hydrateMcpRegistry({ registry, manager, store: mcpStore });
  attachMcpPersistence({ registry, manager, store: mcpStore });
  const launches = hydrateMcpLaunches({ store: mcpStore, bootId: mcpBootId });
  attachLaunchPersistence({ launcher, store: mcpStore, bootId: mcpBootId });
  if (result.restoredServers > 0 || result.restoredInstalls > 0) {
    console.log(
      `[ai-factory] mcp registry hydrated: ${result.restoredServers} server(s), ` +
        `${result.restoredInstalls} install(s)` +
        (result.staleHealthMarked > 0
          ? `, ${result.staleHealthMarked} stale health report(s) not trusted`
          : ''),
    );
  }
  return { ...result, ...launches };
}

// Well-known servers, registered (not installed) at boot so the
// trust/approval flow is demonstrable immediately. Skipped when a
// persisted registration already exists — hydration (Batch 21) owns
// the record then, and re-registering would only append noise.
for (const def of [
  { name: 'github', version: '1.0.0', provider: 'github', transport: 'http' as const,
    tools: [{ name: 'get_file_contents' }, { name: 'create_or_update_file' }],
    scopes: ['repo:read'], permissions: ['github.read'] },
  { name: 'filesystem', version: '1.0.0', provider: 'local', transport: 'stdio' as const,
    tools: [{ name: 'read_file' }, { name: 'write_file' }],
    scopes: ['workspace'], permissions: ['filesystem.read', 'filesystem.write'] },
] as McpServerDefinition[]) {
  if (!registry.has(def.name, def.version)) {
    try { registry.register(def); } catch { /* already registered */ }
  }
}

function summarize(name: string, version: string) {
  const server = registry.get(name, version);
  const install = manager.getInstall(name, version);
  return {
    name,
    version,
    provider: server?.provider ?? null,
    transport: server?.transport ?? null,
    tools: (server?.tools ?? []).map((t) => t.name),
    trustLevel: server?.trustLevel ?? 'UNKNOWN',
    approvalPolicy: server?.approvalPolicy ?? 'BLOCKED',
    installStatus: install?.status ?? 'REGISTERED',
    enabled: manager.isEnabled(name, version),
    // §34.2/§34.4 — negotiated protocol state + latest graded health,
    // when the package layer has recorded them (null = never negotiated
    // / never health-checked, not an implicit "fine").
    negotiatedVersion: server?.negotiatedVersion ?? null,
    extensionSet: server?.extensionSet ?? null,
    health: server?.health
      ? { overall: server.health.overall, checkedAt: server.health.checkedAt, failureClass: server.health.failureClass ?? null }
      : null,
    // W-A — remote servers: pinned URL + whether OAuth is configured.
    serverUrl: server?.runtimePolicy?.serverUrl ?? null,
    oauthConfigured: server?.oauth != null,
    // W-A — stateless HTTP: a live connector in this process means
    // capability discovery succeeded (no protocol negotiation exists
    // in the 2026-07-28 stateless model).
    connected: name != null && version != null && remoteConnectors.has(remoteKey(name, version)),
  };
}

const TRUST_LEVELS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'VERIFIED'] as const;
const APPROVABLE_POLICIES = ['AUTO', 'AI_REVIEW', 'HUMAN_APPROVAL'] as const;

/** Parse a trust-endpoint :id of the form name@version (split on the last '@'). */
function parseTrustServerId(id: string): { name: string; version: string } | null {
  const at = id.lastIndexOf('@');
  if (at <= 0 || at === id.length - 1) return null;
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

/** The honest trust presentation for GET /api/mcp/servers/:id/trust. */
function trustView(name: string, version: string) {
  const server = registry.get(name, version)!;
  const install = manager.getInstall(name, version);
  const installStatus = install?.status ?? 'REGISTERED';
  const enabled = manager.isEnabled(name, version);
  const launchable =
    installStatus === 'INSTALLED' && enabled &&
    server.approvalPolicy !== 'BLOCKED' && server.transport === 'stdio';
  const id = `${name}@${version}`;
  const nextSteps: string[] = [];
  if (server.approvalPolicy === 'BLOCKED') {
    nextSteps.push(`POST /api/mcp/servers/${id}/trust/approve (admin) to approve, or /trust/deny to record a denial`);
    nextSteps.push('then POST /api/mcp/install');
  } else if (installStatus !== 'INSTALLED') {
    nextSteps.push('POST /api/mcp/install');
    if (server.approvalPolicy !== 'AUTO') {
      nextSteps.push('POST /api/mcp/review {approved:true} after it returns PENDING_REVIEW');
    }
  } else if (!enabled) {
    nextSteps.push('server is installed but disabled');
  } else if (server.transport !== 'stdio') {
    nextSteps.push('only stdio servers can be launched via POST /api/mcp/launch');
  } else {
    nextSteps.push('POST /api/mcp/launch');
  }
  return {
    name,
    version,
    trustLevel: server.trustLevel,
    approvalPolicy: server.approvalPolicy,
    // The package's recorded assessment, or null when the server has
    // never been assessed — not an implicit "fine".
    assessment: manager.getAssessment(name, version) ?? null,
    installStatus,
    enabled,
    launchable,
    nextSteps,
  };
}

export async function handleMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/mcp
  if (method === 'GET' && path === PREFIX) {
    const servers = registry.list().map((s) => summarize(s.name, s.version));
    return ctx.json(res, 200, { servers }), true;
  }

  // GET /api/mcp/usage
  if (method === 'GET' && path === `${PREFIX}/usage`) {
    const server = url.searchParams.get('server') ?? undefined;
    return ctx.json(res, 200, { usage: manager.usageLog(server) }), true;
  }

  // POST /api/mcp/register
  if (method === 'POST' && path === `${PREFIX}/register`) {
    const body = await ctx.readBody(req);
    const def = body['server'] as McpServerDefinition | undefined;
    if (!def || typeof def.name !== 'string' || typeof def.version !== 'string') {
      return ctx.json(res, 400, { error: 'server {name, version, provider, transport} is required' }), true;
    }
    // W-A — remote servers must pin a URL at registration (§34.3: a
    // changed URL is a changed server). OAuth metadata is validated
    // for shape here; the secret itself lives in the vault.
    // HTTP+SSE ('sse') is refused: deprecated by the MCP spec on
    // 2025-03-26, formally in the 2026-07-28 revision
    // (CVE-2026-16496). Use Streamable HTTP ('http'). Checked on the
    // raw wire value — 'sse' is not a member of the Transport union.
    if ((body['server'] as { transport?: unknown } | undefined)?.transport === 'sse') {
      return ctx.json(res, 400, {
        error: `transport 'sse' is deprecated and no longer accepted (MCP 2025-03-26 / 2026-07-28) — register as 'http' (Streamable HTTP) instead`,
        code: 'MCP_TRANSPORT_DEPRECATED',
      }), true;
    }
    if (def.transport === 'http') {
      const url = def.runtimePolicy?.serverUrl;
      if (typeof url !== 'string' || !url) {
        return ctx.json(res, 400, { error: `transport '${def.transport}' requires runtimePolicy.serverUrl` }), true;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return ctx.json(res, 400, { error: 'serverUrl must be http(s)' }), true;
        }
      } catch {
        return ctx.json(res, 400, { error: 'serverUrl is not a valid URL' }), true;
      }
      if (def.oauth) {
        const o = def.oauth;
        // Static clientId or a Client ID Metadata Document (DCR is
        // deprecated per MCP 2026-07-28) — one of the two is required.
        if ((typeof o.clientId !== 'string' || !o.clientId) && !o.clientIdMetadataUrl) {
          return ctx.json(res, 400, { error: 'oauth.clientId or oauth.clientIdMetadataUrl is required when oauth is configured' }), true;
        }
        if (!o.authorizationEndpoint && !o.tokenEndpoint && !o.issuer) {
          return ctx.json(res, 400, { error: 'oauth needs authorizationEndpoint/tokenEndpoint or issuer (RFC 8414 discovery)' }), true;
        }
      }
    }
    try {
      const s = registry.register(def);
      ctx.audit.record('human', 'MCP_REGISTERED', 'mcp_server', `${s.name}@${s.version}`, {
        provider: s.provider, trustLevel: s.trustLevel,
      });
      return ctx.json(res, 201, { server: summarize(s.name, s.version) }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // POST /api/mcp/install
  if (method === 'POST' && path === `${PREFIX}/install`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    const requestedBy = typeof body['requestedBy'] === 'string' ? body['requestedBy'] : 'human';
    try {
      const outcome = manager.requestInstall(name, version);
      ctx.audit.record(requestedBy, 'MCP_INSTALL_' + outcome.status, 'mcp_server', `${name}@${version}`, {
        reason: outcome.reason ?? null,
      });
      if (!outcome.ok && outcome.status === 'PENDING_REVIEW') {
        return ctx.json(res, 202, { ...outcome }), true;
      }
      if (!outcome.ok) {
        return ctx.json(res, 403, { ...outcome }), true;
      }
      return ctx.json(res, 200, { ...outcome, server: summarize(name, version) }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  // POST /api/mcp/review
  if (method === 'POST' && path === `${PREFIX}/review`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string' || typeof body['approved'] !== 'boolean') {
      return ctx.json(res, 400, { error: 'name, version and approved are required' }), true;
    }
    try {
      const outcome = manager.decideReview(name, version, {
        approved: body['approved'] as boolean,
        reviewer: typeof body['reviewer'] === 'string' ? body['reviewer'] : 'human',
        reason: typeof body['reason'] === 'string' ? body['reason'] : undefined,
      });
      ctx.audit.record('human', 'MCP_REVIEW_DECIDED', 'mcp_server', `${name}@${version}`, {
        approved: body['approved'], status: outcome.status,
      });
      return ctx.json(res, 200, { ...outcome, server: summarize(name, version) }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  // POST /api/mcp/remove
  if (method === 'POST' && path === `${PREFIX}/remove`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    const removed = manager.uninstall(name, version) || registry.remove(name, version);
    // Batch 21: the durable rows go with the registration (cascade to
    // the install row). The uninstall above already fired the
    // persistence observers; this is the explicit delete.
    if (mcpStore && removed) removeMcpServerRecord(mcpStore, name, version);
    if (mcpStore) {
      // Batch 28: removeServer's two deletes are one atomic unit, but
      // a saveInstall that raced *after* the remove committed still
      // lands on a removed registration. Sweep those orphans here,
      // loudly — the cleanup is never silent.
      const orphans = mcpStore.removeOrphanInstalls();
      if (orphans.length > 0) {
        ctx.audit.record('human', 'MCP_INSTALL_ORPHAN_CLEANED', 'mcp_server', `${name}@${version}`, {
          removed: orphans,
        });
      }
    }
    ctx.audit.record('human', 'MCP_REMOVED', 'mcp_server', `${name}@${version}`, {});
    return ctx.json(res, 200, { ok: removed }), true;
  }

  // ---- trust / approval flow (Batch 20, §46) ----
  // :id is `name@version` (split on the last '@'). Trust state lives on
  // the registration (trustLevel/approvalPolicy, §34.1 metadata); the
  // state machine enforced here:
  //
  //   BLOCKED --approve(trustLevel, policy in AUTO|AI_REVIEW|HUMAN_APPROVAL)--> policy
  //   BLOCKED --deny(reason)--> BLOCKED (stays; the denial is recorded)
  //   policy  --revoke(reason)--> BLOCKED + uninstall + stop running launches
  //
  // §34.3 re-approval triggers (scope expansion, version change,
  // executable change) are served by the registry default: a NEW
  // version registers as BLOCKED and must be approved again — approving
  // one version never bleeds trust into another.
  const trustMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/trust(\/(approve|deny|revoke))?$/);
  if (trustMatch && (method === 'GET' || method === 'POST')) {
    const parsed = parseTrustServerId(trustMatch[1]);
    if (!parsed) {
      return ctx.json(res, 400, { error: 'server id must be name@version' }), true;
    }
    const { name, version } = parsed;
    const id = `${name}@${version}`;
    const action = trustMatch[3] as 'approve' | 'deny' | 'revoke' | undefined;
    const server = registry.get(name, version);
    if (!server) {
      return ctx.json(res, 404, { error: `mcp server ${id} is not registered` }), true;
    }
    if (method === 'GET' && !action) {
      return ctx.json(res, 200, trustView(name, version)), true;
    }
    if (method === 'GET') {
      return ctx.json(res, 405, { error: 'use POST for trust approve/deny/revoke' }), true;
    }
    const body = await ctx.readBody(req);
    const reviewer = typeof body['reviewer'] === 'string' ? body['reviewer'] : 'human';

    // POST /api/mcp/servers/:id/trust/approve — admin.
    // Body: {trustLevel, approvalPolicy, basis?, reviewer?}.
    if (action === 'approve') {
      const trustLevel = body['trustLevel'];
      const policy = body['approvalPolicy'];
      if (typeof trustLevel !== 'string' || !(TRUST_LEVELS as readonly string[]).includes(trustLevel)) {
        return ctx.json(res, 400, { error: `trustLevel must be one of ${TRUST_LEVELS.join('|')}` }), true;
      }
      if (policy === 'BLOCKED') {
        return ctx.json(res, 400, { error: 'approving to BLOCKED is a deny — use /trust/deny instead' }), true;
      }
      if (typeof policy !== 'string' || !(APPROVABLE_POLICIES as readonly string[]).includes(policy)) {
        return ctx.json(res, 400, { error: `approvalPolicy must be one of ${APPROVABLE_POLICIES.join('|')}` }), true;
      }
      if (server.approvalPolicy !== 'BLOCKED') {
        ctx.audit.record(reviewer, 'MCP_TRUST_TRANSITION_DENIED', 'mcp_server', id, {
          reason: 'ALREADY_APPROVED', currentPolicy: server.approvalPolicy,
        });
        return ctx.json(res, 409, {
          error: `cannot approve ${id}: approval policy is already ${server.approvalPolicy} (only BLOCKED can be approved)`,
          code: 'MCP_TRUST_TRANSITION',
          currentPolicy: server.approvalPolicy,
        }), true;
      }
      const from = { trustLevel: server.trustLevel, approvalPolicy: server.approvalPolicy };
      const basis = typeof body['basis'] === 'string' ? body['basis'] : undefined;
      manager.assessTrust(name, version, {
        trustLevel: trustLevel as (typeof TRUST_LEVELS)[number],
        approvalPolicy: policy as (typeof APPROVABLE_POLICIES)[number],
        assessedBy: reviewer, notes: basis,
      });
      ctx.audit.record(reviewer, 'MCP_TRUST_APPROVED', 'mcp_server', id, {
        from, to: { trustLevel, approvalPolicy: policy }, basis: basis ?? null,
      });
      return ctx.json(res, 200, {
        ...trustView(name, version),
        message: `approved — next: POST /api/mcp/install${policy === 'AUTO' ? ' (AUTO installs immediately)' : ' then /api/mcp/review after PENDING_REVIEW'}`,
      }), true;
    }

    // POST /api/mcp/servers/:id/trust/deny — admin.
    // Body: {reason?, reviewer?}. Records the decision; the server stays BLOCKED.
    if (action === 'deny') {
      if (server.approvalPolicy !== 'BLOCKED') {
        ctx.audit.record(reviewer, 'MCP_TRUST_TRANSITION_DENIED', 'mcp_server', id, {
          reason: 'NOT_BLOCKED', currentPolicy: server.approvalPolicy,
        });
        return ctx.json(res, 409, {
          error: `cannot deny ${id}: approval policy is ${server.approvalPolicy} (only a BLOCKED server can be denied)`,
          code: 'MCP_TRUST_TRANSITION',
          currentPolicy: server.approvalPolicy,
        }), true;
      }
      const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
      manager.assessTrust(name, version, {
        trustLevel: server.trustLevel, approvalPolicy: 'BLOCKED',
        assessedBy: reviewer, notes: reason,
      });
      ctx.audit.record(reviewer, 'MCP_TRUST_DENIED', 'mcp_server', id, { reason: reason ?? null });
      return ctx.json(res, 200, { ...trustView(name, version), denied: true }), true;
    }

    // POST /api/mcp/servers/:id/trust/revoke — admin.
    // Body: {reason?, reviewer?}. Drops trust, uninstalls, and stops
    // running launches of this server. The forced stop is a deliberate
    // local decision, not a spec MUST: §34.3 says untrusted code must
    // not execute, and a revoked server is no longer trusted to run at
    // all — unlike secret rotation (Batch 19), where the code stays
    // trusted and long-lived connections are left alone with a
    // staleness annotation.
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
    if (server.approvalPolicy === 'BLOCKED') {
      ctx.audit.record(reviewer, 'MCP_TRUST_TRANSITION_DENIED', 'mcp_server', id, {
        reason: 'ALREADY_BLOCKED',
      });
      return ctx.json(res, 409, {
        error: `cannot revoke ${id}: approval policy is already BLOCKED`,
        code: 'MCP_TRUST_TRANSITION',
        currentPolicy: 'BLOCKED',
      }), true;
    }
    const from = { trustLevel: server.trustLevel, approvalPolicy: server.approvalPolicy };
    manager.assessTrust(name, version, {
      trustLevel: 'LOW', approvalPolicy: 'BLOCKED', assessedBy: reviewer, notes: reason,
    });
    const uninstalled = manager.uninstall(name, version);
    let stoppedLaunches = 0;
    for (const rec of launcher.list()) {
      if (rec.server === name && rec.version === version && rec.alive) {
        if (launcher.stop(rec.id, reviewer, ctx.audit)) stoppedLaunches++;
      }
    }
    ctx.audit.record(reviewer, 'MCP_TRUST_REVOKED', 'mcp_server', id, {
      reason: reason ?? null, from, stoppedLaunches, uninstalled,
    });
    return ctx.json(res, 200, { ...trustView(name, version), stoppedLaunches }), true;
  }
  if (trustMatch) {
    return ctx.json(res, 405, { error: 'trust endpoints accept GET (query) and POST (actions) only' }), true;
  }

  // ---- stdio launch with secret injection (Batch 19, §46.2) ----
  // POST /api/mcp/launch — admin. Body: {name, version, command,
  // args?, cwd?, secretEnv?: {ENV_VAR: "secret-name"}}.
  if (method === 'POST' && path === `${PREFIX}/launch`) {
    if (!ctx.secretBroker) {
      return ctx.json(res, 503, {
        error: 'secret broker is not configured on this server',
        code: 'SECRET_BROKER_UNAVAILABLE',
      }), true;
    }
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    const server = registry.get(name, version);
    if (!server) {
      return ctx.json(res, 404, { error: `mcp server ${name}@${version} is not registered` }), true;
    }
    // Batch 20 (§46): a BLOCKED server can never be installed, so the
    // launcher's generic precondition message would be a dead end.
    // Point at the trust endpoint instead.
    if (server.approvalPolicy === 'BLOCKED') {
      return ctx.json(res, 403, {
        error: `refusing to launch ${name}@${version}: approval policy BLOCKED (trust ${server.trustLevel}) — no install can proceed while BLOCKED; approve it first via POST /api/mcp/servers/${name}@${version}/trust/approve (admin), or record a denial via /trust/deny`,
        code: 'MCP_TRUST_NOT_APPROVED',
      }), true;
    }
    const actor = typeof body['requestedBy'] === 'string' ? body['requestedBy'] : 'human';
    try {
      const rec = await launcher.launch({
        server,
        installed: manager.getInstall(name, version)?.status === 'INSTALLED',
        enabled: manager.isEnabled(name, version),
        command: typeof body['command'] === 'string' ? body['command'] : '',
        args: Array.isArray(body['args']) ? (body['args'] as string[]) : undefined,
        cwd: typeof body['cwd'] === 'string' ? body['cwd'] : undefined,
        secretEnv: (body['secretEnv'] as Record<string, string> | undefined),
        actor,
        broker: ctx.secretBroker,
        audit: ctx.audit,
        // Batch 42 — redaction hits on MCP server output become
        // SECRET_REDACTED_HIT detection events (hit count + server id,
        // never secret content) feeding the §81 'security-issue'
        // aggregation. The launch() call is async-fire; ctx (fdb/audit)
        // is long-lived, like the existing MCP_SERVER_EXIT audit below.
        onRedactionHit: ({ source, hits }) =>
          recordRedactionHit(ctx, 'system', { source, sourceType: 'mcp_server', hits }),
      });
      return ctx.json(res, 201, {
        launchId: rec.id, server: rec.server, version: rec.version,
        pid: rec.pid, secretEnvVars: rec.secretEnvVars,
        credentialRefs: rec.credentialRefs,
      }), true;
    } catch (e) {
      if (e instanceof McpLaunchError) {
        return ctx.json(res, e.status, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
  }

  // GET /api/mcp/launches — viewer. Live process table by default;
  // ?history=true returns the persisted launch records (RUNNING for
  // this boot's live launches, plus STOPPED/EXITED/ORPHANED history).
  if (method === 'GET' && path === `${PREFIX}/launches`) {
    if (url.searchParams.get('history') === 'true' && mcpStore) {
      return ctx.json(res, 200, { launches: mcpStore.listLaunches() }), true;
    }
    return ctx.json(res, 200, { launches: launcher.list() }), true;
  }

  // GET /api/mcp/launches/:id/logs — viewer. Logs are redacted at
  // capture time; the endpoint never sees a raw secret value.
  if (method === 'GET' && path.startsWith(`${PREFIX}/launches/`) && path.endsWith('/logs')) {
    const id = path.slice(`${PREFIX}/launches/`.length, -'/logs'.length);
    const logs = launcher.logs(id);
    if (!logs) return ctx.json(res, 404, { error: 'unknown launch id' }), true;
    return ctx.json(res, 200, { launchId: id, ...logs }), true;
  }

  // POST /api/mcp/launches/:id/stop — admin.
  if (method === 'POST' && path.startsWith(`${PREFIX}/launches/`) && path.endsWith('/stop')) {
    const id = path.slice(`${PREFIX}/launches/`.length, -'/stop'.length);
    const stopBody = await ctx.readBody(req);
    const actor = typeof stopBody['requestedBy'] === 'string' ? stopBody['requestedBy'] : 'human';
    if (!launcher.stop(id, actor, ctx.audit)) {
      return ctx.json(res, 404, { error: 'unknown launch id' }), true;
    }
    return ctx.json(res, 200, { ok: true, launchId: id }), true;
  }

  // POST /api/mcp/gate — pre-call authorization check (§46, §73).
  if (method === 'POST' && path === `${PREFIX}/gate`) {
    const body = await ctx.readBody(req);
    const server = body['server'];
    const tool = body['tool'];
    if (typeof server !== 'string' || typeof tool !== 'string') {
      return ctx.json(res, 400, { error: 'server and tool are required' }), true;
    }
    const verdict = gate.checkCall({
      server,
      version: typeof body['version'] === 'string' ? body['version'] : undefined,
      tool,
      agentId: typeof body['agentId'] === 'string' ? body['agentId'] : undefined,
      taskId: typeof body['taskId'] === 'string' ? body['taskId'] : undefined,
      callerPermissions: Array.isArray(body['callerPermissions']) ? (body['callerPermissions'] as string[]) : [],
    });
    if (verdict.allowed) {
      manager.recordUsage({
        server, version: verdict.usedVersion ?? '', tool,
        agentId: typeof body['agentId'] === 'string' ? body['agentId'] : undefined,
      });
    }
    ctx.audit.record('system', 'MCP_GATE_CHECK', 'mcp_server', server, {
      tool, allowed: verdict.allowed, reason: verdict.reason,
    });
    // §91 — gate verdicts on the bus.
    ctx.bus.emit(
      verdict.allowed ? 'GATE_PASSED' : 'GATE_FAILED',
      { server, tool, agentId: typeof body['agentId'] === 'string' ? body['agentId'] : undefined, reason: verdict.reason },
      'mcp',
    );
    // The gate's honest statement about secret staleness (Batch 19,
    // §46.2): env is copied into the child at spawn, so a revoked
    // lease cannot purge a running server. The verdict does not
    // change on this signal — it only annotates it; relaunch is the
    // operator's call. Additive field; the package gate is untouched.
    const gateVerdict = {
      ...verdict,
      secretLeaseState: launcher.secretLeaseState(
        server, typeof body['version'] === 'string' ? body['version'] : undefined,
      ),
    };
    return ctx.json(res, verdict.allowed ? 200 : 403, gateVerdict), true;
  }

  // ------------------------------------------------------------------
  // W-A: remote MCP (Streamable HTTP) + OAuth 2.1 + MCP server mode.
  // ------------------------------------------------------------------

  /**
   * Resolve the OAuth endpoints for a server (explicit or RFC 8414
   * discovery). Also returns the issuer identity the client used —
   * the authorization response's `iss` must match it (RFC 9207).
   */
  async function resolveOAuthEndpoints(server: McpServer): Promise<{ authorizationEndpoint: string; tokenEndpoint: string; issuer: string }> {
    const o = server.oauth;
    if (!o) throw new Error(`mcp server ${server.name}@${server.version} has no OAuth configuration`);
    if (o.authorizationEndpoint && o.tokenEndpoint) {
      return { authorizationEndpoint: o.authorizationEndpoint, tokenEndpoint: o.tokenEndpoint, issuer: o.issuer ?? o.authorizationEndpoint };
    }
    if (o.issuer) {
      const meta = await discoverOAuthMetadata(o.issuer);
      return { authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, issuer: meta.issuer };
    }
    throw new Error('oauth misconfigured: need authorizationEndpoint/tokenEndpoint or issuer');
  }

  function oauthStore(): SecretsBackedOAuthTokenStore | null {
    if (!ctx.secretBroker) return null;
    return new SecretsBackedOAuthTokenStore(ctx.secretBroker);
  }

  /** Authorization header for a remote server (OAuth token when configured). */
  async function remoteAuthHeaders(server: McpServer): Promise<{ headers: Record<string, string>; token: string | null }> {
    if (!server.oauth) return { headers: {}, token: null };
    const store = oauthStore();
    if (!store) {
      throw Object.assign(new Error('secret broker is not configured on this server'), { status: 503 });
    }
    const { tokenEndpoint } = await resolveOAuthEndpoints(server);
    let clientSecret: string | undefined;
    if (server.oauth.clientSecretRef) {
      try {
        clientSecret = await ctx.secretBroker!.resolve(server.oauth.clientSecretRef, {
          actor: 'mcp-oauth',
          purpose: 'mcp-oauth-client-secret',
        });
      } catch {
        throw Object.assign(
          new Error(`oauth client secret ref '${server.oauth.clientSecretRef}' cannot be resolved from the vault`),
          { status: 400 },
        );
      }
    }
    const mgr = new OAuthTokenManager();
    const token = await mgr.getValidAccessToken(
      oauthSecretName(server.name, server.version, server.oauth),
      { tokenEndpoint, clientId: server.oauth.clientId, clientSecret },
      store,
    );
    return { headers: { authorization: `Bearer ${token}` }, token };
  }

  function defaultCallbackUrl(): string {
    const port = process.env.PORT ?? '3100';
    return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
  }

  function pruneOAuthPending(): void {
    const now = Date.now();
    for (const [k, v] of oauthPending) {
      if (v.createdAt + OAUTH_PENDING_TTL_MS < now) oauthPending.delete(k);
    }
  }

  // POST /api/mcp/remote/connect {name, version} — capability discovery
  // against a remote (Streamable HTTP) server and keep its connector
  // for /remote/call. Stateless per the MCP 2026-07-28 revision: there
  // is no initialize handshake and no session — discovery is a direct
  // tools/list + resources/list + prompts/list. (stdio keeps the
  // stateful handshake path; it is untouched.)
  if (method === 'POST' && path === `${PREFIX}/remote/connect`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    // Offline mode: fail closed — never dial out to a remote server.
    if (networkMode().isOffline()) {
      return ctx.json(res, 403, {
        error: `refusing to connect ${name}@${version}: offline mode is enabled`,
        code: NETWORK_OFFLINE_CODE,
      }), true;
    }
    const server = registry.get(name, version);
    if (!server) return ctx.json(res, 404, { error: `mcp server ${name}@${version} is not registered` }), true;
    if (server.transport !== 'http') {
      return ctx.json(res, 400, { error: `transport '${server.transport}' is not remote (use /api/mcp/launch for stdio)` }), true;
    }
    // Egress firewall: pre-check the server's declared network targets
    // (registry/source URL + §34.1 networkTargets) with the global layer.
    // The doHttpRequest guard enforces the actual outbound calls too —
    // this check fails fast with a clear operator-facing refusal.
    try {
      const declared = [server.source, ...(server.networkTargets ?? [])].filter(
        (t): t is string => typeof t === 'string' && /^https?:\/\//i.test(t),
      );
      for (const target of declared) assertEgressAllowed(target, { source: 'mcp-remote' });
    } catch (e) {
      if ((e as { code?: string }).code === EGRESS_BLOCKED_CODE) {
        return ctx.json(res, 403, {
          error: `refusing to connect ${name}@${version}: outbound blocked by the egress firewall`,
          code: EGRESS_BLOCKED_CODE,
        }), true;
      }
      throw e;
    }
    if (server.approvalPolicy === 'BLOCKED') {
      return ctx.json(res, 403, { error: `refusing to connect ${name}@${version}: approval policy BLOCKED`, code: 'MCP_TRUST_NOT_APPROVED' }), true;
    }
    if (manager.getInstall(name, version)?.status !== 'INSTALLED') {
      return ctx.json(res, 403, { error: `refusing to connect ${name}@${version}: not installed`, code: 'MCP_REMOTE_NOT_INSTALLED' }), true;
    }
    if (!manager.isEnabled(name, version)) {
      return ctx.json(res, 403, { error: `refusing to connect ${name}@${version}: disabled`, code: 'MCP_REMOTE_DISABLED' }), true;
    }
    try {
      const { headers } = await remoteAuthHeaders(server);
      const connector: StatelessMcpConnector = new StreamableMcpConnector({ headers });
      await connector.launch(server);
      const caps = await connector.discoverCapabilities(server);
      remoteConnectors.set(remoteKey(name, version), { connector, server });
      ctx.audit.record('human', 'MCP_REMOTE_CONNECTED', 'mcp_server', `${name}@${version}`, {
        transport: server.transport,
        tools: caps.tools.length,
        oauth: server.oauth != null,
      });
      return ctx.json(res, 200, {
        ok: true,
        server: name,
        version,
        transport: server.transport,
        stateless: true,
        tools: caps.tools.map((t) => t.name),
        resources: caps.resources.map((r) => r.uri),
        prompts: caps.prompts.map((p) => p.name),
      }), true;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      return ctx.json(res, status, { error: (e as Error).message, code: 'MCP_REMOTE_CONNECT_FAILED' }), true;
    }
  }

  // POST /api/mcp/remote/call {name, version?, tool, args?, agentId?, taskId?}
  // Full chain: gate.checkCall (with REAL OAuth claims when a token is
  // in play) → withBoundedRetry(connector.callTool).
  if (method === 'POST' && path === `${PREFIX}/remote/call`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const tool = body['tool'];
    if (typeof name !== 'string' || typeof tool !== 'string') {
      return ctx.json(res, 400, { error: 'name and tool are required' }), true;
    }
    // Offline mode: fail closed — existing remote connectors are not
    // usable either (the egress is the call, not just the connect).
    if (networkMode().isOffline()) {
      return ctx.json(res, 403, {
        error: `refusing remote call ${name}.${tool}: offline mode is enabled`,
        code: NETWORK_OFFLINE_CODE,
      }), true;
    }
    const version = typeof body['version'] === 'string' ? body['version'] : undefined;
    const entry = version ? remoteConnectors.get(remoteKey(name, version)) : undefined;
    const live = entry ?? [...remoteConnectors.values()].find((e) => e.server.name === name);
    if (!live) {
      return ctx.json(res, 409, { error: `mcp server '${name}' is not connected — POST /api/mcp/remote/connect first`, code: 'MCP_REMOTE_NOT_CONNECTED' }), true;
    }
    const server = live.server;
    let oauthToken: { audience?: string; scopes: string[] } | undefined;
    try {
      const { token } = await remoteAuthHeaders(server);
      if (token) {
        const claims = decodeJwtClaims(token);
        if (claims) oauthToken = { audience: claims.audience, scopes: claims.scopes };
        // Opaque token: no client-readable claims — enforcement rests
        // with the remote server (see tokenClaimsForGate docs).
      }
    } catch (e) {
      return ctx.json(res, (e as { status?: number }).status ?? 502, { error: (e as Error).message }), true;
    }
    const verdict = gate.checkCall({
      server: server.name,
      version: server.version,
      tool,
      agentId: typeof body['agentId'] === 'string' ? body['agentId'] : undefined,
      taskId: typeof body['taskId'] === 'string' ? body['taskId'] : undefined,
      ...(oauthToken ? { oauthToken } : {}),
    });
    if (!verdict.allowed) {
      ctx.audit.record('system', 'MCP_REMOTE_GATE_DENIED', 'mcp_server', `${server.name}@${server.version}`, {
        tool, reason: verdict.reason,
      });
      return ctx.json(res, 403, { allowed: false, reason: verdict.reason }), true;
    }
    const args =
      body['args'] !== null && typeof body['args'] === 'object' && !Array.isArray(body['args'])
        ? (body['args'] as Record<string, unknown>)
        : {};
    try {
      const result = await withBoundedRetry(() => live.connector.callTool(server, tool, args));
      return ctx.json(res, 200, { ok: true, result }), true;
    } catch (e) {
      return ctx.json(res, 502, { ok: false, error: (e as Error).message, code: 'MCP_REMOTE_CALL_FAILED' }), true;
    }
  }

  // POST /api/mcp/oauth/start {name, version, redirectUri?} — begin the
  // OAuth 2.1 authorization-code flow (PKCE S256 + state).
  if (method === 'POST' && path === `${PREFIX}/oauth/start`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    const server = registry.get(name, version);
    if (!server) return ctx.json(res, 404, { error: `mcp server ${name}@${version} is not registered` }), true;
    if (!server.oauth) return ctx.json(res, 400, { error: 'this server has no OAuth configuration' }), true;
    const redirectUri = typeof body['redirectUri'] === 'string' && body['redirectUri'] ? body['redirectUri'] : defaultCallbackUrl();
    try {
      const { authorizationEndpoint, issuer } = await resolveOAuthEndpoints(server);
      // Client ID Metadata Document (MCP 2026-07-28; DCR deprecated):
      // the document URL itself becomes the client_id, and the redirect
      // URI must be listed in the document.
      const clientId = await resolveClientId(
        { clientId: server.oauth.clientId, clientIdMetadataUrl: server.oauth.clientIdMetadataUrl },
        redirectUri,
      );
      const { verifier, challenge } = generatePkcePair();
      const state = generateState();
      pruneOAuthPending();
      oauthPending.set(state, { name, version, verifier, redirectUri, issuer, createdAt: Date.now() });
      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint,
        clientId,
        redirectUri,
        scopes: server.oauth.scopes,
        state,
        codeChallenge: challenge,
        resource: server.runtimePolicy?.serverUrl,
      });
      ctx.audit.record('human', 'MCP_OAUTH_START', 'mcp_server', `${name}@${version}`, { redirectUri });
      return ctx.json(res, 200, { authorizationUrl, state }), true;
    } catch (e) {
      return ctx.json(res, 502, { error: (e as Error).message, code: 'MCP_OAUTH_START_FAILED' }), true;
    }
  }

  // GET /api/mcp/oauth/callback?code=&state= — the provider redirects
  // here; the code is exchanged (PKCE) and tokens go to the vault.
  if (method === 'GET' && path === `${PREFIX}/oauth/callback`) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const errParam = url.searchParams.get('error');
    const fail = (message: string, status = 400) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="font-family:sans-serif"><h2>OAuth failed</h2><p>${escapeHtml(message)}</p>` +
          `<p>You can close this window.</p></body></html>`,
      );
      return true;
    };
    if (errParam) return fail(`provider returned error: ${errParam} — ${url.searchParams.get('error_description') ?? ''}`);
    if (!code || !state) return fail('missing code or state');
    pruneOAuthPending();
    let pendingKey: string | undefined;
    for (const k of oauthPending.keys()) {
      if (statesEqual(k, state)) { pendingKey = k; break; }
    }
    const pending = pendingKey ? oauthPending.get(pendingKey)! : undefined;
    if (pendingKey) oauthPending.delete(pendingKey);
    if (!pending) return fail('unknown or expired state — restart the login from the McpPanel');
    // RFC 9207: when the authorization server returns `iss`, it must
    // match the issuer this flow was started against.
    try {
      validateAuthorizationResponseIss(pending.issuer, url.searchParams.get('iss'));
    } catch (e) {
      return fail((e as Error).message);
    }
    const server = registry.get(pending.name, pending.version);
    if (!server?.oauth) return fail('server no longer has an OAuth configuration');
    try {
      const { tokenEndpoint } = await resolveOAuthEndpoints(server);
      let clientSecret: string | undefined;
      if (server.oauth.clientSecretRef && ctx.secretBroker) {
        clientSecret = await ctx.secretBroker.resolve(server.oauth.clientSecretRef, {
          actor: 'mcp-oauth', purpose: 'mcp-oauth-client-secret',
        });
      }
      const tokens = await exchangeCodeForToken({
        tokenEndpoint,
        code,
        codeVerifier: pending.verifier,
        clientId: server.oauth.clientId,
        redirectUri: pending.redirectUri,
        clientSecret,
      });
      const store = oauthStore();
      if (!store) return fail('secret broker is not configured on this server', 503);
      await new OAuthTokenManager().saveTokenResponse(oauthSecretName(server.name, server.version, server.oauth), tokens, store);
      ctx.audit.record('human', 'MCP_OAUTH_TOKEN_STORED', 'mcp_server', `${pending.name}@${pending.version}`, {
        scopes: tokens.scope ?? null,
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="font-family:sans-serif"><h2>✅ OAuth login complete</h2>` +
          `<p>${escapeHtml(pending.name)}@${escapeHtml(pending.version)} is now authorized. You can close this window and return to AI Factory.</p></body></html>`,
      );
      return true;
    } catch (e) {
      return fail((e as Error).message, 502);
    }
  }

  // GET /api/mcp/oauth/status?name=&version= — token presence/expiry (no values).
  if (method === 'GET' && path === `${PREFIX}/oauth/status`) {
    const name = url.searchParams.get('name');
    const version = url.searchParams.get('version');
    if (!name || !version) return ctx.json(res, 400, { error: 'name and version are required' }), true;
    const server = registry.get(name, version);
    if (!server) return ctx.json(res, 404, { error: `mcp server ${name}@${version} is not registered` }), true;
    const store = oauthStore();
    const stored = store ? await store.load(oauthSecretName(name, version, server.oauth)) : null;
    return ctx.json(res, 200, {
      configured: server.oauth != null,
      hasToken: stored != null,
      expired: stored ? stored.obtainedAt + (stored.expiresIn ?? 0) * 1000 - 60_000 <= Date.now() && stored.expiresIn !== undefined : null,
      scopes: stored?.scope ?? null,
    }), true;
  }

  // POST /api/mcp/oauth/refresh {name, version} — force a refresh now.
  if (method === 'POST' && path === `${PREFIX}/oauth/refresh`) {
    const body = await ctx.readBody(req);
    const name = body['name'];
    const version = body['version'];
    if (typeof name !== 'string' || typeof version !== 'string') {
      return ctx.json(res, 400, { error: 'name and version are required' }), true;
    }
    const server = registry.get(name, version);
    if (!server?.oauth) return ctx.json(res, 404, { error: 'server not found or has no OAuth configuration' }), true;
    const store = oauthStore();
    if (!store) return ctx.json(res, 503, { error: 'secret broker is not configured on this server' }), true;
    try {
      const { tokenEndpoint } = await resolveOAuthEndpoints(server);
      let clientSecret: string | undefined;
      if (server.oauth.clientSecretRef && ctx.secretBroker) {
        clientSecret = await ctx.secretBroker.resolve(server.oauth.clientSecretRef, {
          actor: 'mcp-oauth', purpose: 'mcp-oauth-client-secret',
        });
      }
      const token = await new OAuthTokenManager().getValidAccessToken(
        oauthSecretName(name, version, server.oauth),
        { tokenEndpoint, clientId: server.oauth.clientId, clientSecret },
        store,
      );
      void token;
      ctx.audit.record('human', 'MCP_OAUTH_REFRESHED', 'mcp_server', `${name}@${version}`, {});
      return ctx.json(res, 200, { ok: true }), true;
    } catch (e) {
      return ctx.json(res, 502, { error: (e as Error).message, code: 'MCP_OAUTH_REFRESH_FAILED' }), true;
    }
  }

  // GET /api/mcp/server-mode — the MCP server-mode kill switch state.
  if (method === 'GET' && path === `${PREFIX}/server-mode`) {
    return ctx.json(res, 200, readServerModeFlag()), true;
  }

  // POST /api/mcp/server-mode {enabled, updatedBy?} — flip the switch.
  if (method === 'POST' && path === `${PREFIX}/server-mode`) {
    const body = await ctx.readBody(req);
    const enabled = body['enabled'];
    if (typeof enabled !== 'boolean') {
      return ctx.json(res, 400, { error: 'enabled (boolean) is required' }), true;
    }
    const updatedBy = typeof body['updatedBy'] === 'string' ? body['updatedBy'] : 'human';
    const flag = writeServerModeFlag(enabled, updatedBy);
    ctx.audit.record(updatedBy, 'MCP_SERVER_MODE_SET', 'mcp_server_mode', 'global', { enabled });
    return ctx.json(res, 200, flag), true;
  }

  return false;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
