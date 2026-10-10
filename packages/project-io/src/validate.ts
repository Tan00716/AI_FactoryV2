/**
 * Import validation for `.ai/` export files (spec §4 module 33, §103).
 *
 * Every file must live under `.ai/`, parse as the minimal YAML subset,
 * and satisfy the schema for its section. Missing required fields and
 * illegal values are reported as ValidationIssue entries; when any issue
 * exists the import is rejected and NOTHING is written.
 *
 * SECURITY: any scalar value stored under a secret-looking key
 * (secret/token/password/api key/credential) is rejected — secrets travel
 * as reference names only (`*_ref` / `env_refs`), never as values.
 */
import { parseYaml, YamlMap, YamlNode, YamlParseError } from './yaml-util';
import type { ValidationIssue } from './types';

const SECRET_KEY_RE = /secret|token|passwd|password|api[-_ ]?key|credential|private[-_ ]?key/i;

function isMap(n: YamlNode): n is YamlMap {
  return typeof n === 'object' && n !== null && !Array.isArray(n);
}

function reqString(doc: YamlMap, key: string, file: string, issues: ValidationIssue[]): string | null {
  const v = doc[key];
  if (typeof v !== 'string' || v.trim() === '') {
    issues.push({ file, message: `missing required field "${key}" (non-empty string)` });
    return null;
  }
  return v;
}

function optString(doc: YamlMap, key: string, file: string, issues: ValidationIssue[]): void {
  const v = doc[key];
  if (v !== undefined && v !== null && typeof v !== 'string') {
    issues.push({ file, message: `field "${key}" must be a string` });
  }
}

function optStringList(doc: YamlMap, key: string, file: string, issues: ValidationIssue[]): void {
  const v = doc[key];
  if (v === undefined || v === null) return;
  if (!Array.isArray(v) || !v.every((i) => typeof i === 'string')) {
    issues.push({ file, message: `field "${key}" must be a list of strings` });
  }
}

function optEnum(doc: YamlMap, key: string, allowed: readonly string[], file: string, issues: ValidationIssue[]): void {
  const v = doc[key];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    issues.push({ file, message: `field "${key}" must be one of: ${allowed.join(', ')}` });
  }
}

function optBool(doc: YamlMap, key: string, file: string, issues: ValidationIssue[]): void {
  const v = doc[key];
  if (v !== undefined && v !== null && typeof v !== 'boolean') {
    issues.push({ file, message: `field "${key}" must be a boolean` });
  }
}

/** Reject secret VALUES anywhere in the document (refs are fine). */
function checkNoSecretValues(node: YamlNode, file: string, issues: ValidationIssue[], path = ''): void {
  if (isMap(node)) {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      const isRef = /_refs?$/.test(k) || k === 'env_refs';
      if (SECRET_KEY_RE.test(k) && !isRef && typeof v === 'string' && v !== '') {
        issues.push({
          file,
          message: `secret value under "${p}" is not allowed in exports — store a reference name (*_ref) instead`,
        });
      }
      checkNoSecretValues(v, file, issues, p);
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => checkNoSecretValues(item, file, issues, `${path}[${i}]`));
  }
}

function parseDoc(file: string, text: string, issues: ValidationIssue[]): YamlMap | null {
  let node: YamlNode;
  try {
    node = parseYaml(text);
  } catch (err) {
    const msg =
      err instanceof YamlParseError ? err.message : err instanceof Error ? err.message : String(err);
    issues.push({ file, message: `YAML parse error: ${msg}` });
    return null;
  }
  if (!isMap(node)) {
    issues.push({ file, message: 'document root must be a mapping' });
    return null;
  }
  return node;
}

function subMap(doc: YamlMap, key: string, file: string, issues: ValidationIssue[]): YamlMap | null {
  const v = doc[key];
  if (v === undefined || v === null) return null;
  if (!isMap(v)) {
    issues.push({ file, message: `section "${key}" must be a mapping` });
    return null;
  }
  return v;
}

function validateProjectYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  const proj = subMap(doc, 'project', file, issues);
  if (!proj) {
    issues.push({ file, message: 'missing required section "project"' });
  } else {
    reqString(proj, 'name', file, issues);
    optString(proj, 'description', file, issues);
    optString(proj, 'path', file, issues);
    optString(proj, 'id', file, issues);
  }
  checkNoSecretValues(doc, file, issues);
}

function validatePolicyYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  const wf = subMap(doc, 'workflow', file, issues);
  if (wf) optEnum(wf, 'production_approval', ['human', 'auto'], file, issues);
  const sec = subMap(doc, 'security', file, issues);
  if (sec) optEnum(sec, 'production_write', ['allowed', 'denied'], file, issues);
  const ag = subMap(doc, 'agents', file, issues);
  if (ag) {
    const v = ag['max_concurrent'];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) <= 0)) {
      issues.push({ file, message: 'agents.max_concurrent must be a positive integer' });
    }
  }
  const dep = subMap(doc, 'deployment', file, issues);
  if (dep) {
    optBool(dep, 'auto_uat', file, issues);
    optBool(dep, 'auto_prod', file, issues);
  }
  const tst = subMap(doc, 'testing', file, issues);
  if (tst) {
    optBool(tst, 'require_unit', file, issues);
    optBool(tst, 'require_e2e', file, issues);
    optBool(tst, 'require_security', file, issues);
  }
  checkNoSecretValues(doc, file, issues);
}

function validateAgentYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'name', file, issues);
  for (const k of ['display_name', 'job_title', 'department', 'mission', 'instructions', 'model']) {
    optString(doc, k, file, issues);
  }
  for (const k of ['skills', 'rules', 'tools', 'permissions']) optStringList(doc, k, file, issues);
  const lvl = doc['autonomy_level'];
  if (lvl !== undefined && lvl !== null && (!Number.isInteger(lvl) || (lvl as number) < 0 || (lvl as number) > 5)) {
    issues.push({ file, message: 'autonomy_level must be an integer 0..5' });
  }
  checkNoSecretValues(doc, file, issues);
}

function validateSkillYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'id', file, issues);
  optString(doc, 'version', file, issues);
  optString(doc, 'description', file, issues);
  optEnum(doc, 'trust_level', ['OFFICIAL', 'REVIEWED', 'UNREVIEWED', 'BLOCKED'], file, issues);
  optEnum(doc, 'status', ['ACTIVE', 'DEPRECATED', 'RETIRED'], file, issues);
  checkNoSecretValues(doc, file, issues);
}

function validateWorkflowYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'name', file, issues);
  optString(doc, 'id', file, issues);
  checkNoSecretValues(doc, file, issues);
}

function validateKnowledgeYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'title', file, issues);
  optString(doc, 'id', file, issues);
  optString(doc, 'content', file, issues);
  optString(doc, 'source', file, issues);
  checkNoSecretValues(doc, file, issues);
}

function validateMemoryYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'title', file, issues);
  reqString(doc, 'type', file, issues);
  optString(doc, 'id', file, issues);
  optString(doc, 'scope', file, issues);
  optString(doc, 'content', file, issues);
  const c = doc['confidence'];
  if (c !== undefined && c !== null && (typeof c !== 'number' || c < 0 || c > 1)) {
    issues.push({ file, message: 'confidence must be a number 0..1' });
  }
  checkNoSecretValues(doc, file, issues);
}

function validateMcpYaml(file: string, text: string, issues: ValidationIssue[]): void {
  const doc = parseDoc(file, text, issues);
  if (!doc) return;
  reqString(doc, 'name', file, issues);
  optString(doc, 'version', file, issues);
  optString(doc, 'provider', file, issues);
  optEnum(doc, 'transport', ['http', 'stdio', 'sse'], file, issues);
  optStringList(doc, 'scopes', file, issues);
  optStringList(doc, 'permissions', file, issues);
  optStringList(doc, 'env_refs', file, issues);
  const tools = doc['tools'];
  if (tools !== undefined && tools !== null) {
    if (!Array.isArray(tools) || !tools.every((t) => isMap(t) && typeof t['name'] === 'string')) {
      issues.push({ file, message: 'tools must be a list of {name} mappings' });
    }
  }
  checkNoSecretValues(doc, file, issues);
}

/**
 * Validate a full `.ai/` export file map. Returns the list of issues;
 * an empty list means the import is accepted.
 */
export function validateImportFiles(files: Record<string, string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const paths = Object.keys(files);

  if (paths.length === 0) {
    issues.push({ file: '<export>', message: 'export contains no files' });
    return issues;
  }
  for (const p of paths) {
    if (!p.startsWith('.ai/')) {
      issues.push({ file: p, message: 'file is outside the .ai/ directory' });
    }
    if (p.includes('..') || p.includes('\\')) {
      issues.push({ file: p, message: 'path traversal is not allowed' });
    }
  }
  if (!paths.includes('.ai/project.yaml')) {
    issues.push({ file: '.ai/project.yaml', message: 'missing required file .ai/project.yaml' });
  }

  for (const [p, text] of Object.entries(files)) {
    if (typeof text !== 'string') {
      issues.push({ file: p, message: 'file content must be text' });
      continue;
    }
    if (p === '.ai/project.yaml') validateProjectYaml(p, text, issues);
    else if (p === '.ai/policy.yaml') validatePolicyYaml(p, text, issues);
    else if (p.startsWith('.ai/agents/')) validateAgentYaml(p, text, issues);
    else if (p.startsWith('.ai/skills/')) validateSkillYaml(p, text, issues);
    else if (p.startsWith('.ai/workflows/')) validateWorkflowYaml(p, text, issues);
    else if (p.startsWith('.ai/knowledge/')) validateKnowledgeYaml(p, text, issues);
    else if (p.startsWith('.ai/memory/')) validateMemoryYaml(p, text, issues);
    else if (p.startsWith('.ai/mcp/')) validateMcpYaml(p, text, issues);
    // Unknown files under .ai/ are ignored (forward compatibility).
  }
  return issues;
}
