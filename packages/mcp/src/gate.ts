/**
 * @ai-factory/mcp — tool-call gate (spec §46, §73).
 *
 * Every tool invocation passes through checkCall() before dispatch. The call
 * is refused — with a machine-readable reason — unless:
 *   1. the server is registered,
 *   2. a suitable version is installed,
 *   3. the install is enabled (globally and for every supplied scope),
 *   4. the tool exists on the server,
 *   5. every permission the tool requires is held (server or caller granted), and
 *   6. the server's §34.3 runtime policy admits the call (OAuth
 *      audience/scope and declared payload size, when presented).
 *
 * Authorized calls are logged with the exact version used.
 */
import { McpManager } from './security';
import { McpRegistry } from './registry';
import { checkResourceSize, evaluateOAuth } from './runtimePolicy';
import { ToolCallContext, ToolCallVerdict } from './types';

export interface GateOptions {
  registry: McpRegistry;
  manager: McpManager;
}

export class ToolCallGate {
  private registry: McpRegistry;
  private manager: McpManager;

  constructor(options: GateOptions) {
    this.registry = options.registry;
    this.manager = options.manager;
  }

  checkCall(ctx: ToolCallContext): ToolCallVerdict {
    // 1. registered?
    const versions = this.registry.versionsOf(ctx.server);
    if (versions.length === 0) {
      return { allowed: false, reason: `denied: server '${ctx.server}' is not registered (unknown MCP = BLOCK)` };
    }

    // 2. installed? pick requested version, else the newest installed one
    let version = ctx.version;
    if (!version) {
      const installed = this.manager.installedVersions(ctx.server);
      if (installed.length === 0) {
        return { allowed: false, reason: `denied: server '${ctx.server}' is not installed` };
      }
      installed.sort((a, b) => (a.version < b.version ? -1 : 1));
      version = installed[installed.length - 1].version;
    }
    const install = this.manager.getInstall(ctx.server, version);
    if (!install || install.status !== 'INSTALLED') {
      return { allowed: false, reason: `denied: server '${ctx.server}@${version}' is not installed` };
    }

    // 3. enabled for the requested scopes?
    const scopes = ctx.scopes ?? [];
    if (ctx.agentId) scopes.push({ kind: 'agent', id: ctx.agentId });
    if (ctx.taskId) scopes.push({ kind: 'task', id: ctx.taskId });
    if (!this.manager.isEnabled(ctx.server, version, scopes)) {
      return { allowed: false, reason: `denied: server '${ctx.server}@${version}' is disabled for the requested scope` };
    }

    // 4. tool provided?
    const server = this.registry.get(ctx.server, version)!;
    const tool = server.tools.find((t) => t.name === ctx.tool);
    if (!tool) {
      return { allowed: false, reason: `denied: tool '${ctx.tool}' is not provided by '${ctx.server}@${version}'` };
    }

    // 5. permissions satisfied?
    const held = new Set([...server.permissions, ...(ctx.callerPermissions ?? [])]);
    const missing = (tool.requiresPermissions ?? []).filter((p) => !held.has(p));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `denied: tool '${ctx.tool}' requires missing permissions: ${missing.join(', ')}`,
      };
    }

    // 6. §34.3 runtime policy — the checks decidable before the call:
    // OAuth audience/scope of the presented token, and the declared
    // payload size against the resource limit. Absent inputs are not
    // checked (the transport remains responsible for them at runtime).
    const policy = server.runtimePolicy;
    if (policy) {
      if (ctx.oauthToken !== undefined) {
        const oauth = evaluateOAuth(policy, ctx.oauthToken);
        if (!oauth.allowed) return { allowed: false, reason: `denied: ${oauth.reason}` };
      }
      if (ctx.resourceBytes !== undefined) {
        const size = checkResourceSize(policy, ctx.resourceBytes);
        if (!size.allowed) return { allowed: false, reason: `denied: ${size.reason}` };
      }
    }

    // authorized — log which version was actually used
    this.manager.recordUsage({
      server: ctx.server,
      version,
      tool: ctx.tool,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
    });

    return { allowed: true, reason: 'ok', usedVersion: version };
  }
}
