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
    const server: McpServer = {
      name: def.name,
      version: def.version,
      provider: def.provider,
      transport: def.transport,
      tools: def.tools ?? [],
      resources: def.resources ?? [],
      scopes: def.scopes ?? [],
      permissions: def.permissions ?? [],
      trustLevel: opts?.trust ?? existing?.trustLevel ?? DEFAULT_TRUST,
      approvalPolicy: opts?.policy ?? existing?.approvalPolicy ?? DEFAULT_POLICY,
      networkRequirements: def.networkRequirements,
      negotiatedVersion: opts?.negotiatedVersion ?? existing?.negotiatedVersion,
      extensionSet:
        opts?.extensionSet !== undefined
          ? [...opts.extensionSet]
          : existing?.extensionSet !== undefined
            ? [...existing.extensionSet]
            : undefined,
      registeredAt: existing?.registeredAt ?? this.clock.now(),
    };
    this.servers.set(k, server);
    return server;
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
