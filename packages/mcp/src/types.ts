/**
 * @ai-factory/mcp — core types (spec §46 MCP Registry, §73 MCP Security).
 *
 * Every MCP server must define: Name, Version, Provider, Transport, Tools,
 * Resources, Scopes, Permissions, Trust Level, Approval Policy, Network
 * Requirements. Default: unknown MCP = BLOCK.
 */

export type Transport = 'stdio' | 'sse' | 'http';

export type TrustLevel = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';

export type ApprovalPolicy = 'AUTO' | 'AI_REVIEW' | 'HUMAN_APPROVAL' | 'BLOCKED';

export interface McpTool {
  name: string;
  description?: string;
  /** permissions this tool requires in order to be invoked */
  requiresPermissions?: string[];
}

export interface McpResource {
  uri: string;
  name?: string;
}

/** §34.1 — a prompt template the server declares (metadata only). */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
}

/**
 * §34.1 — append-only install/activate lifecycle history. Events are
 * never rewritten or removed; an uninstall appends UNINSTALLED, it does
 * not erase the earlier INSTALLED entry.
 */
export type McpLifecycleEventKind =
  | 'REGISTERED'
  | 'RE_REGISTERED'
  | 'TRUST_ASSESSED'
  | 'NEGOTIATED'
  | 'INSTALL_REQUESTED'
  | 'INSTALL_PENDING'
  | 'INSTALLED'
  | 'INSTALL_BLOCKED'
  | 'ENABLED'
  | 'DISABLED'
  | 'UNINSTALLED'
  | 'REMOVED';

export interface McpLifecycleEvent {
  at: number;
  kind: McpLifecycleEventKind;
  actor?: string;
  detail?: string;
}

/**
 * §34.4 — failure classification for the loss-of-contact chain
 * (classify → bounded retry / circuit breaker → compatible alternative).
 */
export type McpFailureClass = 'unreachable' | 'protocol' | 'tool' | 'timeout' | 'unknown';

/**
 * §34.4 — graded health. The four levels are checked in order and
 * reported separately: a server can start (launch) yet fail the
 * protocol handshake, answer the handshake yet expose no usable tools,
 * or list tools yet fail a real execution. A level that could not be
 * exercised is 'unknown' — never silently promoted to 'pass'.
 */
export type McpHealthLevelName = 'launch' | 'protocol' | 'tools' | 'execution';
export type McpHealthLevelStatus = 'pass' | 'fail' | 'unknown';

export interface McpHealthLevelResult {
  level: McpHealthLevelName;
  status: McpHealthLevelStatus;
  detail?: string;
  failureClass?: McpFailureClass;
  at: number;
}

export interface McpHealthReport {
  server: string;
  version: string;
  checkedAt: number;
  /**
   * healthy  — all four levels passed;
   * degraded — launch/protocol/tools passed but real execution is
   *            unverified (no probe tool available);
   * down     — a verified level failed (see levels[] for which).
   */
  overall: 'healthy' | 'degraded' | 'down';
  levels: McpHealthLevelResult[];
  failureClass?: McpFailureClass;
}

export interface McpServer {
  name: string;
  version: string;
  provider: string;
  transport: Transport;
  tools: McpTool[];
  resources: McpResource[];
  /** §34.1 — prompt schemas the server declares. */
  prompts?: McpPrompt[];
  /** OAuth / MCP scopes granted to the integration */
  scopes: string[];
  /** platform-level permissions the server holds */
  permissions: string[];
  trustLevel: TrustLevel;
  approvalPolicy: ApprovalPolicy;
  networkRequirements?: string;
  /** §34.1 — where the server package came from (registry URL, repo, local path…). */
  source?: string;
  /** §34.1 — content hash of the server package as registered (e.g. 'sha256:…'). */
  packageHash?: string;
  /** §34.1 — protocol versions the server declares it can speak (metadata; the actually negotiated one is negotiatedVersion). */
  protocolVersions?: string[];
  /** §34.1 — structured network targets (hosts/URLs); networkRequirements stays the free-text form. */
  networkTargets?: string[];
  /** §34.1 — references (names/ids) of credentials the server uses. References only — never secret values. */
  credentialRefs?: string[];
  /** §34.1/§34.4 — latest graded health report (see health.ts). */
  health?: McpHealthReport;
  /** §34.1 — append-only install/activate history. */
  history?: McpLifecycleEvent[];
  /** §34.3 — runtime restrictions for this server (see runtimePolicy.ts). */
  runtimePolicy?: McpRuntimePolicy;
  /**
   * §34.2 [S4] — negotiated protocol version from the handshake. The
   * implementation MUST persist this; it drives the legacy-server
   * compatibility layer and contract-test gating on protocol upgrades.
   */
  negotiatedVersion?: string;
  /**
   * §34.2 [S4] — negotiated extension set from the handshake
   * (per-request capability negotiation). MUST be persisted alongside
   * the negotiated version.
   */
  extensionSet?: string[];
  registeredAt: number;
}

export interface McpServerDefinition {
  name: string;
  version: string;
  provider: string;
  transport: Transport;
  tools?: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
  scopes?: string[];
  permissions?: string[];
  networkRequirements?: string;
  source?: string;
  packageHash?: string;
  protocolVersions?: string[];
  networkTargets?: string[];
  credentialRefs?: string[];
  runtimePolicy?: McpRuntimePolicy;
}

/**
 * §34.3 — runtime restrictions modelled per server. The enforcement
 * functions live in runtimePolicy.ts; this interface sits with the
 * record types so the server record can carry it without a cycle.
 */
export interface McpRuntimePolicy {
  /** env var names a stdio child may inherit; everything else is stripped */
  stdioEnvAllowlist: string[];
  /** fixed env values set on the child (resolved by the host from credential refs — values never live in this record) */
  stdioEnvFixed?: Record<string, string>;
  /** credential-bearing header names a transport may attach for this server */
  allowedCredentialHeaders: string[];
  /** follow HTTP redirects at all (default stance: no) */
  followRedirects: boolean;
  /** hosts credentials may be forwarded to across a redirect; the origin host is implicitly allowed, others never unless listed */
  redirectHostAllowlist?: string[];
  /** OAuth expectations for tokens presented on this server's calls */
  oauth?: {
    /** the audience the presented token must carry */
    audience?: string;
    /** scopes the token must hold */
    requiredScopes: string[];
  };
  /** 'system' = platform certificate verification required; 'insecure-declared' = explicitly recorded operator stance that verification is off */
  tlsMode: 'system' | 'insecure-declared';
  /** credentials may only be sent over https/wss */
  requireTlsForCredentials: boolean;
  /** the server URL may change at runtime without re-registration/re-approval */
  allowDynamicUrl: boolean;
  /** the pinned URL for http/sse transports, when one is recorded */
  serverUrl?: string;
  /** max bytes for one resource read / tool result payload */
  maxResourceBytes: number;
}

export type InstallStatus = 'REGISTERED' | 'PENDING_REVIEW' | 'INSTALLED' | 'BLOCKED';

export type ScopeKind = 'project' | 'agent' | 'task';

export interface ScopeRef {
  kind: ScopeKind;
  id: string;
}

export interface InstallRecord {
  name: string;
  version: string;
  status: InstallStatus;
  installedAt?: number;
  /** per-scope disable flags; absent = enabled */
  scopeEnabled: Record<string, boolean>;
  lastUsedVersion?: string;
}

export interface TrustAssessment {
  trustLevel: TrustLevel;
  approvalPolicy: ApprovalPolicy;
  assessedAt: number;
  assessedBy?: string;
  notes?: string;
}

export interface InstallOutcome {
  ok: boolean;
  status: InstallStatus;
  /** human-readable reason when the install is denied or left pending */
  reason?: string;
}

export interface ReviewDecision {
  approved: boolean;
  reviewer?: string;
  reason?: string;
}

export interface ToolCallContext {
  server: string;
  version?: string;
  tool: string;
  scopes?: ScopeRef[];
  /** permissions the caller asserts; used together with server permissions */
  callerPermissions?: string[];
  taskId?: string;
  agentId?: string;
  /**
   * §34.3 — size of the resource/payload this call would move, when the
   * caller knows it up front. When the server carries a runtime policy,
   * the gate enforces its size limit against this value.
   */
  resourceBytes?: number;
  /**
   * §34.3 — the OAuth token the call would be made with (audience +
   * granted scopes only, never the token value). When the server
   * carries a runtime policy with OAuth expectations, the gate checks
   * audience/scope before allowing the call.
   */
  oauthToken?: { audience?: string; scopes: string[] };
}

export interface ToolCallVerdict {
  allowed: boolean;
  /** why the call was denied (or 'ok' when allowed) */
  reason: string;
  /** the installed server version the call was authorized against */
  usedVersion?: string;
}

export interface ToolUsage {
  server: string;
  version: string;
  tool: string;
  agentId?: string;
  taskId?: string;
  at: number;
}

export interface Clock {
  now: () => number;
}

/* ------------------------------------------------------------------ */
/* Transport connector (§34.2 handshake, §34.4 graded health)          */
/* ------------------------------------------------------------------ */

/** What a successful initialize handshake reports back (§34.2). */
export interface McpInitializeResult {
  /** the protocol version the server selected for this session */
  protocolVersion: string;
  /** extension set negotiated for this session (per-request capability negotiation) */
  extensions?: string[];
  serverInfo?: { name?: string; version?: string };
  /** tools the server reported during the handshake, when it reports any */
  tools?: McpTool[];
  prompts?: McpPrompt[];
}

export interface McpToolCallResult {
  ok: boolean;
  /** the tool itself returned an error payload (JSON-RPC result with isError) */
  isError?: boolean;
  errorText?: string;
  content?: unknown;
}

/**
 * Transport-level client for ONE MCP server. stdio servers get a real
 * transport via StdioMcpConnector (stdio-connector.ts); SSE/HTTP still
 * need a production client, and tests wire a fixture. Each method maps
 * to one graded-health level.
 */
export interface McpConnector {
  /** level 'launch': the process starts / the connection opens */
  launch(server: McpServer): Promise<void>;
  /** level 'protocol': the initialize handshake is answered */
  initialize(server: McpServer, clientProtocolVersions: string[]): Promise<McpInitializeResult>;
  /** level 'tools': tools/list is answered */
  listTools(server: McpServer): Promise<McpTool[]>;
  listPrompts?(server: McpServer): Promise<McpPrompt[]>;
  /** level 'execution': a real tool invocation completes */
  callTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close?(server: McpServer): Promise<void> | void;
}
