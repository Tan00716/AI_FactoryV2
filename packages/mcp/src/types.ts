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

export interface McpServer {
  name: string;
  version: string;
  provider: string;
  transport: Transport;
  tools: McpTool[];
  resources: McpResource[];
  /** OAuth / MCP scopes granted to the integration */
  scopes: string[];
  /** platform-level permissions the server holds */
  permissions: string[];
  trustLevel: TrustLevel;
  approvalPolicy: ApprovalPolicy;
  networkRequirements?: string;
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
  scopes?: string[];
  permissions?: string[];
  networkRequirements?: string;
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
