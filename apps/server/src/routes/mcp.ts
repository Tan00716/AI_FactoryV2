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

const PREFIX = '/api/mcp';

const registry = new McpRegistry();
const manager = new McpManager(registry);
const gate = new ToolCallGate({ registry, manager });

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
    return ctx.json(res, verdict.allowed ? 200 : 403, verdict), true;
  }

  return false;
}
