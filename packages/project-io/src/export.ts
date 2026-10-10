/**
 * Export a project's configuration to the `.ai/` directory structure
 * (spec §103):
 *
 *   .ai/
 *   ├── project.yaml
 *   ├── policy.yaml
 *   ├── agents/      one yaml per agent
 *   ├── skills/
 *   ├── workflows/
 *   ├── knowledge/
 *   ├── memory/
 *   └── mcp/
 *
 * SECURITY: credential/secret VALUES are never exported. For MCP server
 * `env` only the reference names are written (`env_refs`); the values must
 * be re-entered or re-linked from the vault after import.
 */
import { stringifyYamlDoc, YamlMap, YamlNode } from './yaml-util';
import type {
  AgentExport,
  ExportFiles,
  KnowledgeExport,
  McpServerExport,
  MemoryExport,
  ProjectExportData,
  ProjectPolicyData,
  SkillExport,
  WorkflowExport,
} from './types';

/** Filename-safe slug for per-entity yaml files. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unnamed';
}

/** Drop undefined / null / empty-string / empty-array values. */
function compact(obj: { [k: string]: unknown }): YamlMap {
  const out: YamlMap = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v as YamlNode;
  }
  return out;
}

const DEFAULT_POLICY: Required<ProjectPolicyData> = {
  production_approval: 'human',
  production_write: 'denied',
  max_concurrent_agents: 8,
  auto_uat: true,
  auto_prod: false,
  require_unit: true,
  require_e2e: true,
  require_security: true,
};

function policyDoc(projectName: string, p?: ProjectPolicyData): YamlMap {
  const merged = { ...DEFAULT_POLICY, ...compact({ ...(p ?? {}) }) };
  return {
    project: { name: projectName },
    workflow: { production_approval: merged.production_approval },
    security: { production_write: merged.production_write },
    agents: { max_concurrent: merged.max_concurrent_agents },
    deployment: { auto_uat: merged.auto_uat, auto_prod: merged.auto_prod },
    testing: {
      require_unit: merged.require_unit,
      require_e2e: merged.require_e2e,
      require_security: merged.require_security,
    },
  } as YamlMap;
}

function agentDoc(a: AgentExport): YamlMap {
  return compact({
    name: a.name,
    display_name: a.displayName,
    job_title: a.jobTitle,
    department: a.department,
    mission: a.mission,
    instructions: a.instructions,
    skills: a.skills,
    rules: a.rules,
    model: a.model,
    tools: a.tools,
    permissions: a.permissions,
    autonomy_level: a.autonomyLevel,
  });
}

function skillDoc(s: SkillExport): YamlMap {
  return compact({
    id: s.id,
    version: s.version,
    description: s.description,
    trust_level: s.trustLevel,
    status: s.status,
  });
}

function workflowDoc(w: WorkflowExport): YamlMap {
  const doc = compact({ id: w.id, name: w.name });
  if (w.definition !== undefined && w.definition !== null) doc['definition'] = w.definition as YamlNode;
  return doc;
}

function knowledgeDoc(k: KnowledgeExport): YamlMap {
  return compact({
    id: k.id,
    title: k.title,
    content: k.content,
    source: k.source,
  });
}

function memoryDoc(m: MemoryExport): YamlMap {
  return compact({
    id: m.id,
    scope: m.scope,
    type: m.type,
    title: m.title,
    content: m.content,
    confidence: m.confidence,
  });
}

function mcpDoc(s: McpServerExport): YamlMap {
  const doc = compact({
    name: s.name,
    version: s.version,
    provider: s.provider,
    transport: s.transport,
    tools: s.tools?.map((t) => ({ name: t.name })),
    scopes: s.scopes,
    permissions: s.permissions,
  });
  // Secrets: export reference NAMES only, never values.
  if (s.env && Object.keys(s.env).length > 0) {
    doc['env_refs'] = Object.keys(s.env);
  }
  return doc;
}

/**
 * Build the `.ai/` file map for a project. Pure function — the caller
 * decides how to transport or persist the files.
 */
export function buildExportFiles(data: ProjectExportData): ExportFiles {
  const files: ExportFiles = {};
  const p = data.project;

  files['.ai/project.yaml'] = stringifyYamlDoc(
    compact({
      project: compact({
        id: p.id,
        name: p.name,
        description: p.description,
        path: p.path,
      }),
    }),
  );

  files['.ai/policy.yaml'] = stringifyYamlDoc(policyDoc(p.name, data.policy));

  for (const a of data.agents) {
    files[`.ai/agents/${slug(a.id || a.name)}.yaml`] = stringifyYamlDoc(agentDoc(a));
  }
  for (const s of data.skills) {
    files[`.ai/skills/${slug(s.id)}.yaml`] = stringifyYamlDoc(skillDoc(s));
  }
  for (const w of data.workflows) {
    files[`.ai/workflows/${slug(w.id || w.name)}.yaml`] = stringifyYamlDoc(workflowDoc(w));
  }
  for (const k of data.knowledge) {
    files[`.ai/knowledge/${slug(k.id)}.yaml`] = stringifyYamlDoc(knowledgeDoc(k));
  }
  for (const m of data.memory) {
    files[`.ai/memory/${slug(m.id)}.yaml`] = stringifyYamlDoc(memoryDoc(m));
  }
  for (const s of data.mcp) {
    files[`.ai/mcp/${slug(s.name)}.yaml`] = stringifyYamlDoc(mcpDoc(s));
  }
  return files;
}
