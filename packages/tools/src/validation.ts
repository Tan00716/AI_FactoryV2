/**
 * Tool definition validation — SPEC v2 §33.
 *
 * register() only hard-rejects the identity fields (id/version) and an
 * invalid category, for backward compatibility with definitions written
 * before the taxonomy. validateToolMetadata() is the full completeness
 * check a definition SHOULD pass: every §33 metadata field present and
 * well-formed (ID/Version, source, Input/Output Schema, capabilities,
 * side-effect classification, network/filesystem requirements,
 * timeout, idempotency/cancel/reconcile, health, approval policy).
 * It reports issues; it never throws and never mutates the definition.
 */
import { isToolCategory, type FieldSchema, type ToolMetadata, type ToolSchema } from './types';

export interface ToolMetadataIssue {
  field: string;
  message: string;
}

const FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'object', 'array']);
const SIDE_EFFECTS: ReadonlySet<string> = new Set(['none', 'read', 'write', 'network', 'external']);
const APPROVAL_POLICIES: ReadonlySet<string> = new Set([
  'AUTO',
  'AI_REVIEW_PLUS_POLICY',
  'HUMAN_APPROVAL',
  'BLOCKED',
]);
const HEALTH_STATES: ReadonlySet<string> = new Set(['unknown', 'healthy', 'degraded', 'down']);
const IMPLEMENTATION_STATUSES: ReadonlySet<string> = new Set(['implemented', 'definition-only']);

function checkFieldSchema(path: string, field: unknown, issues: ToolMetadataIssue[]): void {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    issues.push({ field: path, message: 'field schema must be an object' });
    return;
  }
  const f = field as FieldSchema & Record<string, unknown>;
  if (!FIELD_TYPES.has(f.type as string)) {
    issues.push({ field: path, message: `invalid field type ${JSON.stringify(f.type)}` });
    return;
  }
  if (f.required !== undefined && typeof f.required !== 'boolean') {
    issues.push({ field: path, message: 'required must be a boolean' });
  }
  if (f.enum !== undefined && !Array.isArray(f.enum)) {
    issues.push({ field: path, message: 'enum must be an array' });
  }
  if (f.maxLength !== undefined && (typeof f.maxLength !== 'number' || f.maxLength < 0)) {
    issues.push({ field: path, message: 'maxLength must be a non-negative number' });
  }
  if (f.type === 'object' && f.properties !== undefined) {
    checkSchema(`${path}.properties`, f.properties as ToolSchema, issues);
  }
  if (f.type === 'array' && f.items !== undefined) {
    checkFieldSchema(`${path}.items`, f.items, issues);
  }
}

function checkSchema(path: string, schema: unknown, issues: ToolMetadataIssue[]): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({ field: path, message: 'schema must be an object mapping field names to field schemas' });
    return;
  }
  for (const [name, field] of Object.entries(schema as Record<string, unknown>)) {
    checkFieldSchema(`${path}.${name}`, field, issues);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/** Full §33 completeness check. An empty result means the definition is complete. */
export function validateToolMetadata(meta: ToolMetadata): ToolMetadataIssue[] {
  const issues: ToolMetadataIssue[] = [];
  const m = (meta ?? {}) as ToolMetadata & Record<string, unknown>;

  if (typeof m.id !== 'string' || !m.id) issues.push({ field: 'id', message: 'id is required' });
  if (typeof m.version !== 'string' || !m.version) {
    issues.push({ field: 'version', message: 'version is required' });
  }
  if (typeof m.source !== 'string' || !m.source) {
    issues.push({ field: 'source', message: 'source is required' });
  }
  if (m.category !== undefined && !isToolCategory(m.category)) {
    issues.push({ field: 'category', message: `not a §33 category: ${JSON.stringify(m.category)}` });
  }
  if (m.implementationStatus !== undefined && !IMPLEMENTATION_STATUSES.has(m.implementationStatus)) {
    issues.push({
      field: 'implementationStatus',
      message: `must be 'implemented' or 'definition-only'`,
    });
  }
  checkSchema('inputSchema', m.inputSchema, issues);
  checkSchema('outputSchema', m.outputSchema, issues);
  if (!isStringArray(m.capabilities) || m.capabilities.length === 0) {
    issues.push({ field: 'capabilities', message: 'at least one capability action is required' });
  }
  if (!SIDE_EFFECTS.has(m.sideEffect as string)) {
    issues.push({ field: 'sideEffect', message: `invalid side-effect class ${JSON.stringify(m.sideEffect)}` });
  }
  if (!isStringArray(m.networkRequirements)) {
    issues.push({ field: 'networkRequirements', message: 'must be an array of strings (may be empty)' });
  }
  if (!isStringArray(m.filesystemRequirements)) {
    issues.push({
      field: 'filesystemRequirements',
      message: 'must be an array of strings (may be empty)',
    });
  }
  if (typeof m.timeoutMs !== 'number' || !Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0) {
    issues.push({ field: 'timeoutMs', message: 'timeoutMs must be a positive number' });
  }
  for (const flag of ['idempotency', 'cancelable', 'reconcilable'] as const) {
    if (typeof m[flag] !== 'boolean') issues.push({ field: flag, message: `${flag} must be a boolean` });
  }
  if (!HEALTH_STATES.has(m.health as string)) {
    issues.push({ field: 'health', message: `invalid health state ${JSON.stringify(m.health)}` });
  }
  if (!APPROVAL_POLICIES.has(m.approvalPolicy as string)) {
    issues.push({
      field: 'approvalPolicy',
      message: `invalid approval policy ${JSON.stringify(m.approvalPolicy)}`,
    });
  }
  if (m.evidenceCollector !== undefined && typeof m.evidenceCollector !== 'string') {
    issues.push({ field: 'evidenceCollector', message: 'evidenceCollector must be a string' });
  }
  return issues;
}
