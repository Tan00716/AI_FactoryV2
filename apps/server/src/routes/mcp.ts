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
 *
 * Unknown sources default to BLOCKED (§73). An install that needs review
 * returns 202 with the pending-review descriptor; re-issue /review after
 * a human (or AI reviewer) decides. Every install/review/remove/gate call
 * writes an audit record.
 *
 * The coordinator wires this in: handleMcpRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: registry is in-memory (lost on restart).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  McpRegistry,
  McpManager,
  ToolCallGate,
  type McpServerDefinition,
} from '@ai-factory/mcp';
import type { RouteContext } from './context';
import { McpServerLauncher, McpLaunchError } from '../mcp-launcher';

const PREFIX = '/api/mcp';

const registry = new McpRegistry();
const manager = new McpManager(registry);
const gate = new ToolCallGate({ registry, manager });
// Process table for launched stdio MCP servers. One instance per
// process — launches die with the server, and that is stated in
// KNOWN_LIMITATIONS (same honesty as the merge queue / PrStore).
const launcher = new McpServerLauncher();

// Well-known servers, registered (not installed) at boot so the
// trust/approval flow is demonstrable immediately.
for (const def of [
  { name: 'github', version: '1.0.0', provider: 'github', transport: 'http' as const,
    tools: [{ name: 'get_file_contents' }, { name: 'create_or_update_file' }],
    scopes: ['repo:read'], permissions: ['github.read'] },
  { name: 'filesystem', version: '1.0.0', provider: 'local', transport: 'stdio' as const,
    tools: [{ name: 'read_file' }, { name: 'write_file' }],
    scopes: ['workspace'], permissions: ['filesystem.read', 'filesystem.write'] },
] as McpServerDefinition[]) {
  try { registry.register(def); } catch { /* already registered */ }
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
    ctx.audit.record('human', 'MCP_REMOVED', 'mcp_server', `${name}@${version}`, {});
    return ctx.json(res, 200, { ok: removed }), true;
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

  // GET /api/mcp/launches — viewer.
  if (method === 'GET' && path === `${PREFIX}/launches`) {
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
