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
  TrustAssessment,
  TrustLevel,
} from './types';

const DEFAULT_TRUST: TrustLevel = 'UNKNOWN';
const DEFAULT_POLICY: ApprovalPolicy = 'BLOCKED';

export interface RegistryOptions {
  clock?: Clock;
  /**
   * Durability seam (Batch 21, §46; op protocol since Batch 25): when
   * set, every mutation of a registration record is reported as an
   * OPERATION so a host can apply it atomically against the fresh
   * persisted row. The registry itself stays storage-agnostic.
   *
   * Why ops and not post-mutation states: each server process holds
   * its own in-memory registry. A blind full-row upsert computed from
   * stale memory silently reverts another process's writes (Batch 25
   * audit: a health write reverted a trust approval to BLOCKED and
   * dropped its history). Ops carry only the mutation intent, so the
   * durability layer can apply them inside a write transaction on the
   * current row — concurrent processes stop clobbering each other.
   */
  sink?: McpRegistrySink;
}

/**
 * A durable mutation intent for one (name, version) server record.
 *
 *  - register: ensure a registration; the merge-with-existing runs
 *    against the FRESH row (trust/policy/negotiation survive a
 *    concurrent re-registration from a stale process).
 *  - setFields: overwrite the named fields, leave everything else.
 *  - appendHistory: append events (never rewrites).
 *  - setAssessment: set trustLevel/approvalPolicy from an assessment
 *    (the assessment JSON itself is a row-mapping concern).
 */
export type McpServerOp =
  | {
      kind: 'register';
      def: McpServerDefinition;
      opts?: {
        trust?: TrustLevel;
        policy?: ApprovalPolicy;
        negotiatedVersion?: string;
        extensionSet?: string[];
      };
    }
  | { kind: 'setFields'; fields: Partial<McpServer> }
  | { kind: 'appendHistory'; events: McpLifecycleEvent[] }
  | { kind: 'setAssessment'; assessment: TrustAssessment };

/**
 * Persistence observer for registration records. Called after each
 * mutating operation (register / recordNegotiation / recordHealth /
 * appendHistory / trust assessment) with the mutation intent — NOT a
 * full post-mutation state (see the op-protocol note above).
 */
export interface McpRegistrySink {
  onServerOp(name: string, version: string, op: McpServerOp): void;
}

/**
 * Pure application of one McpServerOp to a record. Shared by the
 * in-memory registry (base = its Map entry) and the durability layer
 * (base = the freshly-read DB row), so both compute the same result.
 * Returns a NEW object; callers decide how to install it.
 */
export function applyMcpServerOp(
  name: string,
  version: string,
  current: McpServer | undefined,
  op: McpServerOp,
  clock: Clock = { now: () => Date.now() },
): McpServer {
  switch (op.kind) {
    case 'register':
      return mergeRegistration(name, version, current, op.def, op.opts, clock);
    case 'setFields': {
      if (!current) {
        throw new Error(`mcp: cannot set fields — ${name}@${version} is not registered`);
      }
      return { ...current, ...op.fields };
    }
    case 'appendHistory': {
      if (!current) {
        throw new Error(`mcp: cannot append history — ${name}@${version} is not registered`);
      }
      const history = [...(current.history ?? [])];
      for (const e of op.events) {
        history.push({
          at: e.at ?? clock.now(),
          kind: e.kind,
          ...(e.actor !== undefined ? { actor: e.actor } : {}),
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
        });
      }
      return { ...current, history };
    }
    case 'setAssessment': {
      if (!current) {
        throw new Error(`mcp: cannot set assessment — ${name}@${version} is not registered`);
      }
      return {
        ...current,
        trustLevel: op.assessment.trustLevel,
        approvalPolicy: op.assessment.approvalPolicy,
      };
    }
  }
}

/**
 * Registration merge: a value the new definition supplies wins; an
 * omitted one preserves what the previous registration recorded;
 * trust/policy survive unless explicitly overridden (unknown MCP =
 * BLOCK stays the default for genuinely new servers).
 */
function mergeRegistration(
  name: string,
  version: string,
  existing: McpServer | undefined,
  def: McpServerDefinition,
  opts:
    | {
        trust?: TrustLevel;
        policy?: ApprovalPolicy;
        negotiatedVersion?: string;
        extensionSet?: string[];
      }
    | undefined,
  clock: Clock,
): McpServer {
  // §34.1 metadata fields follow the negotiation rule: a value the
  // new definition supplies wins; an omitted one preserves what the
  // previous registration recorded (metadata refresh must not erase).
  const keep = <T>(next: T | undefined, prev: T | undefined): T | undefined =>
    next !== undefined ? next : prev;
  const server: McpServer = {
    name,
    version,
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
    registeredAt: existing?.registeredAt ?? clock.now(),
  };
  server.history!.push({
    // First registration reuses registeredAt (one clock read per
    // registration, as before); a re-registration is a new event and
    // takes its own timestamp.
    at: existing ? clock.now() : server.registeredAt,
    kind: existing ? 'RE_REGISTERED' : 'REGISTERED',
  });
  return server;
}

export class McpRegistry {
  private servers = new Map<string, McpServer>();
  private clock: Clock;
  private sink?: McpRegistrySink;

  constructor(options: RegistryOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sink = options.sink;
  }

  /** Attach (or replace) the durability sink after construction. */
  setSink(sink: McpRegistrySink | undefined): void {
    this.sink = sink;
  }

  private emitOp(name: string, version: string, op: McpServerOp): void {
    this.sink?.onServerOp(name, version, op);
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
   *
   * The merge runs through applyMcpServerOp so the durability layer
   * can replay the identical merge against the fresh DB row (Batch 25:
   * a stale process's re-registration must not revert another
   * process's trust approval).
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
    const op: McpServerOp = { kind: 'register', def, opts };
    const server = applyMcpServerOp(def.name, def.version, existing, op, this.clock);
    this.servers.set(k, server);
    this.emitOp(def.name, def.version, op);
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
    const k = McpRegistry.key(name, version);
    const server = this.servers.get(k);
    if (!server) throw new Error(`mcp: cannot record negotiation — ${name}@${version} is not registered`);
    const fields: Partial<McpServer> = {
      negotiatedVersion: negotiated.negotiatedVersion,
      extensionSet: negotiated.extensionSet ? [...negotiated.extensionSet] : [],
    };
    const setOp: McpServerOp = { kind: 'setFields', fields };
    Object.assign(server, applyMcpServerOp(name, version, server, setOp, this.clock));
    this.emitOp(name, version, setOp);
    this.appendHistory(name, version, { kind: 'NEGOTIATED', detail: negotiated.negotiatedVersion });
    return this.servers.get(k)!;
  }

  /** §34.4 — persist the latest graded health report on the record. */
  recordHealth(name: string, version: string, report: McpHealthReport): McpServer {
    const k = McpRegistry.key(name, version);
    const server = this.servers.get(k);
    if (!server) throw new Error(`mcp: cannot record health — ${name}@${version} is not registered`);
    const op: McpServerOp = { kind: 'setFields', fields: { health: report } };
    Object.assign(server, applyMcpServerOp(name, version, server, op, this.clock));
    this.emitOp(name, version, op);
    return server;
  }

  /** Append one entry to the server's install/activate history (§34.1). Never rewrites. */
  appendHistory(
    name: string,
    version: string,
    event: { kind: McpLifecycleEvent['kind']; actor?: string; detail?: string; at?: number },
  ): void {
    const k = McpRegistry.key(name, version);
    const server = this.servers.get(k);
    if (!server) return;
    const op: McpServerOp = {
      kind: 'appendHistory',
      events: [{ at: event.at ?? this.clock.now(), kind: event.kind, actor: event.actor, detail: event.detail }],
    };
    Object.assign(server, applyMcpServerOp(name, version, server, op, this.clock));
    this.emitOp(name, version, op);
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
