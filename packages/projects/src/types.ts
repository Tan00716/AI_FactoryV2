/**
 * Shared types for @ai-factory/projects — local project execution,
 * discovery and scaffolding (spec §6, §31–§33).
 */
import type { ProjectTemplateRegistry } from './templates';

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
  /**
   * SPEC §7.5 — autonomous agent execution. When true, the constructor runs
   * the fail-closed confinement gate: without a verified isolation backend
   * it throws ConfinementUnavailableError. @default false (human/operator use)
   */
  autonomous?: boolean;
  /**
   * Isolation backend for the §7.5 gate. Required when autonomous is true;
   * a missing backend fails closed (treated as unverified).
   */
  isolationBackend?: import('@ai-factory/security').IsolationBackend;
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

/**
 * How firmly a discovered fact is established (spec §6.2).
 *
 * 'detected'  — the configuration was found on disk, nothing more.
 * 'verified' — the command/config was actually executed and succeeded.
 *
 * Discovery is read-only (§6.2: executing project scripts needs an
 * authorized task with EXECUTE capability), so `discoverProject` only
 * ever produces 'detected'. 'verified' is reserved for a future
 * execution-backed verification path — it must never be inferred from
 * the mere presence of configuration.
 */
export type DetectionStatus = 'detected' | 'verified';

/** A command discovered in project configuration (spec §6.2). */
export interface DetectedCommand {
  /** Command role, e.g. 'test' | 'build' | 'dev' | 'start' | 'lint'. */
  kind: string;
  /** The literal command line that would run. */
  command: string;
  /** Where it was found, e.g. 'package.json scripts.test'. */
  source: string;
  /** 'detected' until a real run succeeds — never guessed (§6.2). */
  status: DetectionStatus;
}

/** Diagnostic codes recorded during discovery (spec §6.2). */
export type ProjectDiagnosticCode =
  | 'MULTIPLE_LOCKFILES'
  | 'MISSING_MANIFEST'
  | 'NO_TEST_COMMAND'
  | 'UNKNOWN_COMMAND';

/**
 * A non-fatal discovery finding (spec §6.2). Diagnostics are how the
 * profile says "something is off" instead of guessing a PASS.
 */
export interface ProjectDiagnostic {
  code: ProjectDiagnosticCode;
  /** Human-readable explanation, naming the concrete evidence. */
  message: string;
  /** Project-relative path the finding is about, when applicable. */
  path?: string;
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
  /**
   * Commands found in project configuration (spec §6.2). Every entry is
   * status 'detected' — discovery never executes anything.
   */
  commands: DetectedCommand[];
  /**
   * Discovery diagnostics (spec §6.2): multiple lockfiles, a missing
   * manifest, an unrecognized command, or no test command are recorded
   * here instead of being silently papered over.
   */
  diagnostics: ProjectDiagnostic[];
}

export type ProjectTemplateName =
  | 'nextjs-saas'
  | 'react'
  | 'python-api'
  | 'node-api'
  | 'electron';

/** A runnable-minimal project skeleton. */
export interface ProjectTemplate {
  /**
   * Template slug. The five builtins keep the ProjectTemplateName
   * literals; registered templates (Batch 33) may use any valid slug,
   * so this is string, not the builtin union.
   */
  name: string;
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
  /**
   * Template slug: a builtin ProjectTemplateName or a name registered
   * on the registry (Batch 33 widened this from the builtin union).
   */
  template?: string;
  /** Target parent dir or full path; defaults to the current working dir. */
  dir?: string;
  /**
   * Allow writing into a target directory that already exists and is
   * non-empty (spec §6.3 forbids overwriting a non-empty directory).
   * @default false — a non-empty target throws DirectoryNotEmptyError.
   */
  force?: boolean;
  /**
   * Registry the template name is resolved against. Defaults to
   * defaultTemplateRegistry (the five builtins). The server passes its
   * own registry so registered templates work in /api/projects/create.
   */
  registry?: ProjectTemplateRegistry;
}

export interface CreatedProject {
  /** Absolute path of the new project. */
  dir: string;
  name: string;
  template: string | null;
  /** Relative paths of every file written (sorted). */
  files: string[];
  /** True when `git init` ran successfully. */
  gitInitialized: boolean;
}
