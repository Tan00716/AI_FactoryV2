/**
 * Shared types for @ai-factory/projects — local project execution,
 * discovery and scaffolding (spec §6, §31–§33).
 */

/** Workspace permissions from spec §6. */
export type WorkspacePermission =
  | 'READ'
  | 'WRITE'
  | 'CREATE'
  | 'DELETE'
  | 'EXECUTE'
  | 'NETWORK'
  | 'GIT'
  | 'PROCESS'
  | 'PORT';

export interface AuditEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** Agent that issued the execution. */
  agentId: string;
  /** Event kind, e.g. 'exec' | 'exec_rejected'. */
  kind: string;
  /** The command that was attempted. */
  command: string;
  /** Resolved working directory used. */
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Human-readable reason when kind is a rejection. */
  reason?: string;
}

export interface WorkspaceExecutorOptions {
  /** Sandbox root; all commands run with cwd constrained inside it. */
  root: string;
  /** §6 permission subset granted to this workspace. */
  permissions: WorkspacePermission[];
  /** Agent id attached to every audit event. */
  agentId: string;
  /** Optional sink for audit events. */
  onAudit?: (event: AuditEvent) => void;
  /**
   * Extra first-token commands to allow (or replace the defaults).
   * @default merges with DEFAULT_ALLOWED_COMMANDS
   */
  allowedCommands?: string[];
  /** Default kill timeout for exec(). @default 30000 ms */
  timeoutMs?: number;
  /** Per-stream stdout/stderr truncation limit in bytes. @default 262144 */
  maxOutputBytes?: number;
}

export interface ExecOptions {
  /** Relative path inside root; defaults to the sandbox root. */
  cwd?: string;
  /** Override the executor's default timeout in ms. */
  timeoutMs?: number;
  /** Extra environment variables for this run. */
  env?: Record<string, string>;
}

export interface ExecResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when stdout or stderr hit the truncation limit. */
  truncated: boolean;
  durationMs: number;
}

/** Result of `discoverProject` (spec §32). */
export interface ProjectProfile {
  /** Absolute path that was analyzed. */
  path: string;
  /** Primary language, e.g. 'javascript' | 'typescript' | 'python' | 'go'. */
  language: string | null;
  /** Framework, e.g. 'react' | 'next' | 'fastapi'. Null when unknown. */
  framework: string | null;
  /** Package manager, e.g. 'npm' | 'pnpm' | 'poetry'. Null when unknown. */
  packageManager: string | null;
  /** Test framework, e.g. 'jest' | 'pytest'. Null when unknown. */
  testFramework: string | null;
  /** .git directory present. */
  git: boolean;
  /** Detected CI providers, e.g. ['github-actions', 'gitlab']. */
  ci: string[];
  /** AGENTS.md present at the project root. */
  hasAgentsMd: boolean;
  /** skills/ directory present at the project root. */
  skillsDir: boolean;
  /** MCP config file found (.ai/mcp/*.json, mcp.json, .mcp.json). */
  mcpConfig: string | null;
}

export type ProjectTemplateName =
  | 'nextjs-saas'
  | 'react'
  | 'python-api'
  | 'node-api'
  | 'electron';

/** A runnable-minimal project skeleton. */
export interface ProjectTemplate {
  name: ProjectTemplateName;
  description: string;
  language: string;
  framework: string;
  packageManager: string;
  /** Relative path → file contents. */
  files: Record<string, string>;
}

export interface CreateProjectOptions {
  /** Directory-safe project name. */
  name: string;
  template?: ProjectTemplateName;
  /** Target parent dir or full path; defaults to the current working dir. */
  dir?: string;
}

export interface CreatedProject {
  /** Absolute path of the new project. */
  dir: string;
  name: string;
  template: ProjectTemplateName | null;
  /** Relative paths of every file written (sorted). */
  files: string[];
  /** True when `git init` ran successfully. */
  gitInitialized: boolean;
}
