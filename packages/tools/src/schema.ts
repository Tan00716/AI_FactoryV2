/**
 * Hand-written schema validators (zero dependencies) — SPEC v2 §33
 * (Input/Output Schema per tool).
 */
import type { FieldSchema, ToolSchema } from './types';

export interface SchemaIssue {
  field: string;
  message: string;
}

function checkField(path: string, schema: FieldSchema, value: unknown, issues: SchemaIssue[]): void {
  if (value === undefined || value === null) {
    if (schema.required) issues.push({ field: path, message: 'required field missing' });
    return;
  }
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== schema.type) {
    issues.push({ field: path, message: `expected ${schema.type}, got ${actual}` });
    return;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    issues.push({ field: path, message: `not in enum: ${schema.enum.join(', ')}` });
  }
  if (schema.type === 'string' && schema.maxLength !== undefined && (value as string).length > schema.maxLength) {
    issues.push({ field: path, message: `exceeds maxLength ${schema.maxLength}` });
  }
  if (schema.type === 'object' && schema.properties) {
    validateObject(path, schema.properties, value as Record<string, unknown>, issues);
  }
  if (schema.type === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => checkField(`${path}[${i}]`, schema.items!, item, issues));
  }
}

function validateObject(
  base: string,
  schema: ToolSchema,
  value: Record<string, unknown>,
  issues: SchemaIssue[],
): void {
  for (const [key, field] of Object.entries(schema)) {
    checkField(base ? `${base}.${key}` : key, field, value[key], issues);
  }
}

export function validateInput(schema: ToolSchema, args: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateObject('', schema, args, issues);
  return issues;
}
