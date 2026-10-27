/**
 * Validation for managed rules (round-6 R6-A6). Pure functions, zero deps.
 *
 * Names are identifiers, not paths: no separators, no leading dot, no
 * control characters. Ids are derived server-side (never trusted from the
 * client) so two rules can never collide on id.
 */
import {
  MAX_RULE_CONTENT_BYTES,
  MAX_RULE_NAME_LENGTH,
  type ManagedRule,
} from './types.js';

export function validateRuleName(name: unknown): string[] {
  const issues: string[] = [];
  if (typeof name !== 'string' || !name.trim()) {
    issues.push('name is required');
    return issues;
  }
  if (name.length > MAX_RULE_NAME_LENGTH) {
    issues.push(`name exceeds ${MAX_RULE_NAME_LENGTH} characters`);
  }
  if (name !== name.trim()) issues.push('name must not have leading/trailing whitespace');
  if (/[/\\]/.test(name)) issues.push('name must not contain path separators');
  if (name.startsWith('.')) issues.push('name must not start with a dot');
  if (/[\u0000-\u001f\u007f]/.test(name)) issues.push('name must not contain control characters');
  return issues;
}

export function validateRuleContent(content: unknown): string[] {
  const issues: string[] = [];
  if (typeof content !== 'string') {
    issues.push('content must be a string');
    return issues;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_RULE_CONTENT_BYTES) {
    issues.push(`content exceeds ${MAX_RULE_CONTENT_BYTES} bytes`);
  }
  return issues;
}

export function validateRuleOrder(order: unknown): string[] {
  if (order === undefined) return [];
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
    return ['order must be a non-negative integer'];
  }
  return [];
}

/** Case-insensitive name equality: 'Foo' and 'foo' are the same rule name. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function sortRules(rules: ManagedRule[]): ManagedRule[] {
  return [...rules].sort((x, y) => (x.order - y.order) || x.name.localeCompare(y.name));
}
