/**
 * Shared types for @ai-factory/project-io — project import/export
 * (spec §4 module 33, §98 project.yaml, §99 organization policy, §103 .ai/).
 *
 * The export format is a flat file map: relative path (under `.ai/`) →
 * file text. The server may transport it as multi-file JSON; the desktop
 * downloads/uploads it as a single `.ai-export.json` document.
 */

/** Relative path → file text. Keys are relative to the project dir. */
export type ExportFiles = Record<string, string>;

export interface ProjectExportData {
  project: {
    id: string;
    name: string;
    description?: string;
    path?: string;
  };
  /** Spec §98 project policy; defaults are merged in on export. */
  policy?: ProjectPolicyData;
  agents: AgentExport[];
  skills: SkillExport[];
  workflows: WorkflowExport[];
  knowledge: KnowledgeExport[];
  memory: MemoryExport[];
  mcp: McpServerExport[];
}

export interface ProjectPolicyData {
  production_approval?: 'human' | 'auto';
  production_write?: 'allowed' | 'denied';
  max_concurrent_agents?: number;
  auto_uat?: boolean;
  auto_prod?: boolean;
  require_unit?: boolean;
  require_e2e?: boolean;
  require_security?: boolean;
}

export interface AgentExport {
  id: string;
  name: string;
  displayName?: string;
  jobTitle?: string;
  department?: string;
  mission?: string;
  instructions?: string;
  skills?: string[];
  rules?: string[];
  model?: string;
  tools?: string[];
  permissions?: string[];
  autonomyLevel?: number;
}

export interface SkillExport {
  id: string;
  version?: string;
  description?: string;
  trustLevel?: string;
  status?: string;
}

export interface WorkflowExport {
  id: string;
  name: string;
  definition?: unknown;
}

export interface KnowledgeExport {
  id: string;
  title?: string;
  content?: string;
  source?: string;
}

export interface MemoryExport {
  id: string;
  scope?: string;
  type: string;
  title: string;
  content?: string;
  confidence?: number;
}

/**
 * MCP server definition. SECURITY: environment / credential values are
 * NEVER exported — only their reference names go into `env_refs`.
 * Values must be re-entered (or re-linked from the vault) after import.
 */
export interface McpServerExport {
  name: string;
  version?: string;
  provider?: string;
  transport?: string;
  tools?: { name: string }[];
  scopes?: string[];
  permissions?: string[];
  /** Credential VALUES — stripped on export, kept only for typing. */
  env?: Record<string, string>;
}

export interface ValidationIssue {
  /** Relative file path inside the export, e.g. `.ai/agents/builder.yaml`. */
  file: string;
  /** Human-readable description of the problem. */
  message: string;
}

export interface ImportResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Absolute paths written (only when ok). */
  written: string[];
}

/** Format marker embedded in the transport envelope. */
export const EXPORT_FORMAT = 'ai-dir-json/v1';
