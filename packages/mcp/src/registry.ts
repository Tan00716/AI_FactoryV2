/**
 * @ai-factory/mcp — server registration store (spec §46, §73).
 *
 * In-memory only. A server is REGISTERED with trust UNKNOWN and a BLOCKED
 * approval policy by default — "unknown MCP = BLOCK". Versions of the same
 * server coexist; a server definition is keyed by (name, version).
 */
import {
  ApprovalPolicy,
  Clock,
  McpHealthReport,
  McpLifecycleEvent,
  McpServer,
  McpServerDefinition,
  TrustLevel,
} from './types';

const DEFAULT_TRUST: TrustLevel = 'UNKNOWN';
const DEFAULT_POLICY: ApprovalPolicy = 'BLOCKED';

export interface RegistryOptions {
  clock?: Clock;
}

export class McpRegistry {
  private servers = new Map<string, McpServer>();
  private clock: Clock;

  constructor(options: RegistryOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  private static key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /**
   * Register (or re-register) a server definition. Defaults to
   * trust UNKNOWN + approval BLOCKED unless the definition is an
   * update of an already-assessed server (trust is preserved).
   *
   * §34.2 [S4]: pass `opts.negotiatedVersion` / `opts.extensionSet` on a
   * successful handshake — they are persisted on the registration record
   * and preserved across re-registrations that do not supply new values.
   */
  register(
    def: McpServerDefinition,
    opts?: {
      trust?: TrustLevel;
      policy?: ApprovalPolicy;
      negotiatedVersion?: string;
      extensionSet?: string[];
    },
  ): McpServer {
    const k = McpRegistry.key(def.name, def.version);
    const existing = this.servers.get(k);
    // §34.1 metadata fields follow the negotiation rule: a value the
    // new definition supplies wins; an omitted one preserves what the
    // previous registration recorded (metadata refresh must not erase).
    const keep = <T>(next: T | undefined, prev: T | undefined): T | undefined =>
      next !== undefined ? next : prev;
    const server: McpServer = {
      name: def.name,
      version: def.version,
      provider: def.provider,
      transport: def.transport,
      tools: def.tools ?? existing?.tools ?? [],
      resources: def.resources ?? existing?.resources ?? [],
      prompts: keep(def.prompts, existing?.prompts),
      scopes: def.scopes ?? [],
      permissions: def.permissions ?? [],
      trustLevel: opts?.trust ?? existing?.trustLevel ?? DEFAULT_TRUST,
      approvalPolicy: opts?.policy ?? existing?.approvalPolicy ?? DEFAULT_POLICY,
      networkRequirements: keep(def.networkRequirements, existing?.networkRequirements),
      source: keep(def.source, existing?.source),
      packageHash: keep(def.packageHash, existing?.packageHash),
      protocolVersions: keep(def.protocolVersions, existing?.protocolVersions),
      networkTargets: keep(def.networkTargets, existing?.networkTargets),
      credentialRefs: keep(def.credentialRefs, existing?.credentialRefs),
      runtimePolicy: keep(def.runtimePolicy, existing?.runtimePolicy),
      health: existing?.health,
      history: existing?.history ? [...existing.history] : [],
      negotiatedVersion: opts?.negotiatedVersion ?? existing?.negotiatedVersion,
      extensionSet:
        opts?.extensionSet !== undefined
          ? [...opts.extensionSet]
          : existing?.extensionSet !== undefined
            ? [...existing.extensionSet]
            : undefined,
      registeredAt: existing?.registeredAt ?? this.clock.now(),
    };
    server.history!.push({
      // First registration reuses registeredAt (one clock read per
      // registration, as before); a re-registration is a new event and
      // takes its own timestamp.
      at: existing ? this.clock.now() : server.registeredAt,
      kind: existing ? 'RE_REGISTERED' : 'REGISTERED',
    });
    this.servers.set(k, server);
    return server;
  }

  /**
   * §34.2 [S4] — persist the outcome of a successful initialize
   * handshake on the registration record. This is the write path the
   * handshake/health code uses; register(opts) remains for callers
   * that already hold the values.
   */
  recordNegotiation(
    name: string,
    version: string,
    negotiated: { negotiatedVersion: string; extensionSet?: string[] },
  ): McpServer {
    const server = this.servers.get(McpRegistry.key(name, version));
    if (!server) throw new Error(`mcp: cannot record negotiation — ${name}@${version} is not registered`);
    server.negotiatedVersion = negotiated.negotiatedVersion;
    server.extensionSet = negotiated.extensionSet ? [...negotiated.extensionSet] : [];
    this.appendHistory(name, version, { kind: 'NEGOTIATED', detail: negotiated.negotiatedVersion });
    return server;
  }

  /** §34.4 — persist the latest graded health report on the record. */
  recordHealth(name: string, version: string, report: McpHealthReport): McpServer {
    const server = this.servers.get(McpRegistry.key(name, version));
    if (!server) throw new Error(`mcp: cannot record health — ${name}@${version} is not registered`);
    server.health = report;
    return server;
  }

  /** Append one entry to the server's install/activate history (§34.1). Never rewrites. */
  appendHistory(
    name: string,
    version: string,
    event: { kind: McpLifecycleEvent['kind']; actor?: string; detail?: string; at?: number },
  ): void {
    const server = this.servers.get(McpRegistry.key(name, version));
    if (!server) return;
    const { at, ...rest } = event;
    (server.history ??= []).push({ at: at ?? this.clock.now(), ...rest });
  }

  get(name: string, version: string): McpServer | undefined {
    return this.servers.get(McpRegistry.key(name, version));
  }

  /** all registered versions of a server, sorted by version string */
  versionsOf(name: string): McpServer[] {
    return [...this.servers.values()]
      .filter((s) => s.name === name)
      .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  }

  list(): McpServer[] {
    return [...this.servers.values()];
  }

  has(name: string, version: string): boolean {
    return this.servers.has(McpRegistry.key(name, version));
  }

  remove(name: string, version: string): boolean {
    return this.servers.delete(McpRegistry.key(name, version));
  }
}
