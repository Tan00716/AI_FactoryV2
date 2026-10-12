/**
 * @ai-factory/mcp — graded health checks (§34.4).
 *
 * "健康检查区分启动成功、协议连接、工具可用和真实执行成功" — the four
 * levels are exercised strictly in order and reported separately:
 *
 *   launch     the process starts / the connection opens
 *   protocol   the initialize handshake is answered (a successful
 *              handshake also persists the negotiated version and
 *              extension set on the record — §34.2 [S4])
 *   tools      tools/list is answered
 *   execution  one real tool invocation succeeds
 *
 * The execution level uses a lightweight probe: an explicitly named
 * probe tool, else a well-known no-op style tool (ping/echo/health…)
 * from the server's LIVE tool list. When no probe tool exists the
 * level is reported 'unknown' and the server is 'degraded' — a lower
 * level passing is never presented as proof that execution works.
 *
 * Every check writes its report onto the registration record
 * (server.health), so the current health is queryable state, not a
 * transient return value.
 */
import { McpRegistry } from './registry';
import { CLIENT_PROTOCOL_VERSIONS, classifyMcpError } from './handshake';
import {
  Clock,
  McpConnector,
  McpHealthLevelResult,
  McpHealthReport,
  McpTool,
} from './types';

/** Tool names treated as safe no-op probes for the execution level. */
export const PROBE_TOOL_NAMES: readonly string[] = [
  'ping',
  'echo',
  'health',
  'healthcheck',
  'health_check',
  'status',
];

export interface HealthCheckOptions {
  clock?: Clock;
  /** protocol versions this client can speak, newest first */
  clientProtocolVersions?: readonly string[];
  /** explicit probe tool for the execution level (must exist on the server) */
  probeTool?: string;
  probeArgs?: Record<string, unknown>;
  /** candidate probe names, in preference order (defaults to PROBE_TOOL_NAMES) */
  probeToolNames?: readonly string[];
}

export class McpHealthChecker {
  private clock: Clock;

  constructor(
    private registry: McpRegistry,
    private connector: McpConnector,
    private defaults: HealthCheckOptions = {},
  ) {
    this.clock = defaults.clock ?? { now: () => Date.now() };
  }

  async check(name: string, version: string, opts: HealthCheckOptions = {}): Promise<McpHealthReport> {
    const server = this.registry.get(name, version);
    if (!server) throw new Error(`mcp: cannot health-check — ${name}@${version} is not registered`);
    const clientVersions = opts.clientProtocolVersions ?? this.defaults.clientProtocolVersions ?? CLIENT_PROTOCOL_VERSIONS;
    const levels: McpHealthLevelResult[] = [];
    const at = () => this.clock.now();
    const finish = (): McpHealthReport => {
      const failed = levels.find((l) => l.status === 'fail');
      const exec = levels.find((l) => l.level === 'execution');
      const overall: McpHealthReport['overall'] = failed
        ? 'down'
        : exec && exec.status === 'pass'
          ? 'healthy'
          : 'degraded';
      const report: McpHealthReport = {
        server: name,
        version,
        checkedAt: at(),
        overall,
        levels,
        failureClass: failed?.failureClass,
      };
      this.registry.recordHealth(name, version, report);
      return report;
    };
    const fail = (level: McpHealthLevelResult['level'], err: unknown, stage: 'launch' | 'protocol' | 'tools' | 'execution') => {
      const cls = classifyMcpError(err, stage);
      levels.push({
        level,
        status: 'fail',
        failureClass: cls,
        detail: err instanceof Error ? err.message : String(err),
        at: at(),
      });
    };

    try {
      // Level 1 — launch.
      try {
        await this.connector.launch(server);
        levels.push({ level: 'launch', status: 'pass', at: at() });
      } catch (err) {
        fail('launch', err, 'launch');
        return finish();
      }

      // Level 2 — protocol handshake. Success persists the negotiation (§34.2).
      let liveTools: McpTool[] | undefined;
      try {
        const init = await this.connector.initialize(server, [...clientVersions]);
        this.registry.recordNegotiation(name, version, {
          negotiatedVersion: init.protocolVersion,
          extensionSet: init.extensions ? [...init.extensions] : [],
        });
        liveTools = init.tools;
        levels.push({
          level: 'protocol',
          status: 'pass',
          detail: `negotiated ${init.protocolVersion}`,
          at: at(),
        });
      } catch (err) {
        fail('protocol', err, 'protocol');
        return finish();
      }

      // Level 3 — tools/list answers.
      try {
        const listed = await this.connector.listTools(server);
        liveTools = listed;
        const registered = new Set(server.tools.map((t) => t.name));
        const drift = listed.filter((t) => !registered.has(t.name)).map((t) => t.name);
        levels.push({
          level: 'tools',
          status: 'pass',
          detail:
            `${listed.length} tool(s) listed` +
            (drift.length ? `; unregistered on the record: ${drift.join(', ')} (§34.2 compatibility check)` : ''),
          at: at(),
        });
      } catch (err) {
        fail('tools', err, 'tools');
        return finish();
      }

      // Level 4 — one real execution. No probe tool ⇒ unknown, never faked.
      const probe = pickProbe(liveTools ?? [], opts, this.defaults);
      if (!probe) {
        levels.push({
          level: 'execution',
          status: 'unknown',
          detail:
            'no probe tool available (none of the probe names exists on this server and no explicit probeTool was configured); real execution is unverified',
          at: at(),
        });
        return finish();
      }
      try {
        const res = await this.connector.callTool(server, probe, opts.probeArgs ?? this.defaults.probeArgs ?? {});
        if (res.ok && !res.isError) {
          levels.push({ level: 'execution', status: 'pass', detail: `probe tool '${probe}' executed`, at: at() });
        } else {
          levels.push({
            level: 'execution',
            status: 'fail',
            failureClass: 'tool',
            detail: `probe tool '${probe}' returned an error${res.errorText ? `: ${res.errorText}` : ''}`,
            at: at(),
          });
        }
      } catch (err) {
        fail('execution', err, 'execution');
      }
      return finish();
    } finally {
      try {
        await this.connector.close?.(server);
      } catch {
        /* closing a broken connection must not mask the report */
      }
    }
  }
}

function pickProbe(
  liveTools: McpTool[],
  opts: HealthCheckOptions,
  defaults: HealthCheckOptions,
): string | undefined {
  const explicit = opts.probeTool ?? defaults.probeTool;
  if (explicit) return liveTools.some((t) => t.name === explicit) ? explicit : undefined;
  const names = opts.probeToolNames ?? defaults.probeToolNames ?? PROBE_TOOL_NAMES;
  for (const n of names) {
    if (liveTools.some((t) => t.name === n)) return n;
  }
  return undefined;
}
