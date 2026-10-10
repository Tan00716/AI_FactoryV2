/**
 * Tool Registry types — SPEC v2 §33.
 */

/** Side-effect classification (SPEC v2 §33). */
export type SideEffectClass = 'none' | 'read' | 'write' | 'network' | 'external';

/** Tool approval policy (SPEC v2 §23.4 tool approval levels). */
export type ToolApprovalPolicy = 'AUTO' | 'AI_REVIEW_PLUS_POLICY' | 'HUMAN_APPROVAL' | 'BLOCKED';

/** Minimal hand-written input/output schema (zero dependencies). */
export interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  enum?: Array<string | number>;
  properties?: Record<string, FieldSchema>;
  items?: FieldSchema;
  maxLength?: number;
}
export type ToolSchema = Record<string, FieldSchema>;

/**
 * Tool metadata record (SPEC v2 §33: ID/Version, source, schemas,
 * capabilities, side-effect classification, network/filesystem
 * requirements, timeout, idempotency/cancel/reconcile support, health,
 * approval policy, artifact/evidence collector).
 */
export interface ToolMetadata {
  id: string;
  version: string;
  source: string;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  /** Logical actions this tool can perform, e.g. 'filesystem.write'. */
  capabilities: string[];
  sideEffect: SideEffectClass;
  networkRequirements: string[];
  filesystemRequirements: string[];
  timeoutMs: number;
  idempotency: boolean;
  cancelable: boolean;
  reconcilable: boolean;
  health: 'unknown' | 'healthy' | 'degraded' | 'down';
  approvalPolicy: ToolApprovalPolicy;
  evidenceCollector?: string;
}

/** Calling principal. */
export interface ToolPrincipal {
  id: string;
  type: 'HUMAN' | 'AI' | 'SERVICE';
}

/**
 * Capability grant checked at the execution point. Binds a principal to
 * logical actions over resource prefixes — NOT to tool names, so an
 * alternate tool (python `open`, another MCP) gets the same verdict.
 */
export interface CapabilityGrant {
  id: string;
  principalId: string;
  /** Logical actions, e.g. ['filesystem.read', 'filesystem.write']. */
  actions: string[];
  /** Resource prefixes the actions apply to, e.g. ['/ws/project-a/']. */
  resourcePrefixes: string[];
  expiresAt: string | null;
  revoked?: boolean;
}

export interface ToolCall {
  toolId: string;
  toolVersion?: string;
  args: Record<string, unknown>;
  /** Logical action the caller claims, e.g. 'filesystem.write'. */
  action: string;
  /** Resource the action targets, e.g. '/ws/project-a/notes.txt'. */
  resource: string;
  principal: ToolPrincipal;
  capability: CapabilityGrant;
  idempotencyKey?: string;
  cwd?: string;
}

export type ExecutionOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'DENIED';

/**
 * Unified execution record (§33). `exitCode` is the truth: a natural-language
 * "success" in output never overrides a non-zero exit code.
 */
export interface ExecutionRecord {
  id: string;
  toolId: string;
  toolVersion: string;
  action: string;
  resource: string;
  argv: Record<string, unknown>;
  cwd: string;
  envRef: string;
  principal: ToolPrincipal;
  capabilityId: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outcome: ExecutionOutcome;
  /** True when secret material was redacted from argv/stdout/stderr. */
  redacted: boolean;
  artifacts: string[];
  note?: string;
}
