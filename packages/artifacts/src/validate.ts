/**
 * Schema validation for artifact field payloads (spec §23).
 *
 * Rules:
 *  - every required field must be present: strings must be non-blank,
 *    everything else must not be undefined/null
 *  - every required (and present optional) field must match its declared
 *    FieldType
 *  - extra fields not in the schema are allowed
 *
 * Failures throw ArtifactValidationError naming every missing field and
 * every type mismatch.
 */
import {
  ArtifactSchema,
  ArtifactType,
  ArtifactValidationError,
  FieldSpec,
  FieldType,
} from './types';

function isBlankString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length === 0;
}

function actualType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((i) => typeof i === 'string');
    case 'record':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'isoDate':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    default:
      return false;
  }
}

/**
 * Validate a field payload against a type schema.
 * @throws ArtifactValidationError listing missing required fields and type mismatches.
 */
export function validateFields(type: ArtifactType, schema: ArtifactSchema, fields: Record<string, unknown>): void {
  const missing: string[] = [];
  const typeErrors: { field: string; expected: FieldType; actual: string }[] = [];
  const check = (spec: FieldSpec, required: boolean): void => {
    const value = fields[spec.name];
    const absent = value === undefined || value === null || isBlankString(value);
    if (absent) {
      if (required) missing.push(spec.name);
      return;
    }
    if (!matchesType(value, spec.type)) {
      typeErrors.push({ field: spec.name, expected: spec.type, actual: actualType(value) });
    }
  };
  for (const spec of schema.required) check(spec, true);
  for (const spec of schema.optional) check(spec, false);
  if (missing.length > 0 || typeErrors.length > 0) {
    throw new ArtifactValidationError(type, missing, typeErrors);
  }
}
