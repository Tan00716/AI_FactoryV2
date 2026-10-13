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
  type McpServerDefinition,
} from '@ai-factory/mcp';
import type { RouteContext } from './context';
import type { FactoryDatabase, McpServerStore } from '@ai-factory/db';
import { McpServerLauncher, McpLaunchError } from '../mcp-launcher';
import {
  hydrateMcpRegistry,
  attachMcpPersistence,
  removeMcpServerRecord,
  hydrateMcpLaunches,
  attachLaunchPersistence,
  newMcpBootId,
} from '../mcp-persistence';

const PREFIX = '/api/mcp';

const registry = new McpRegistry();
const manager = new McpManager(registry);
const gate = new ToolCallGate({ registry, manager });
// Process table for launched stdio MCP servers. One instance per
// process — launches die with the server, and that is stated in
// KNOWN_LIMITATIONS (same honesty as the merge queue / PrStore).
const launcher = new McpServerLauncher();

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

  return false;
}
