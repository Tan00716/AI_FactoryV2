/**
 * Fail-closed rule validation (R6-S3). Every field is checked; a rule
 * with any invalid field is rejected whole — never stored half-valid.
 * Unknown fields are ignored (forward-compatible), never rejected.
 */
import {
  DEFAULT_DEBOUNCE_MS,
  MAX_DEBOUNCE_MS,
  MAX_GLOBS_PER_RULE,
  MAX_LABEL_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MIN_DEBOUNCE_MS,
  type WatchRule,
} from './types';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RuleValidation {
  rule: WatchRule | null;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an unknown value as a WatchRule. `id` may be omitted by the
 * caller (the route generates one); when present it must match ID_RE.
 */
export function validateRule(value: unknown): RuleValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { rule: null, errors: ['rule must be an object'] };
  const rawId = value['id'];
  const id = typeof rawId === 'string' ? rawId : '';
  if (rawId !== undefined && !ID_RE.test(id)) {
    errors.push('id must match [A-Za-z0-9_-]{1,64} and start alphanumerically');
  }
  const name = value['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name is required');
  } else if (name.length > MAX_RULE_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_RULE_NAME_LENGTH} characters`);
  }
  const globs = value['globs'];
  if (!Array.isArray(globs) || globs.length === 0) {
    errors.push('globs must be a non-empty array');
  } else {
    if (globs.length > MAX_GLOBS_PER_RULE) {
      errors.push(`at most ${MAX_GLOBS_PER_RULE} globs per rule`);
    }
    for (const g of globs) {
      if (typeof g !== 'string' || g.trim().length === 0) {
        errors.push('each glob must be a non-empty string');
        break;
      }
      // Absolute patterns and parent escapes never match a relative path;
      // reject them loudly instead of silently matching nothing.
      const norm = g.replace(/\\/g, '/');
      if (norm.startsWith('/') || norm.split('/').includes('..')) {
        errors.push(`glob must be project-relative (no leading / or ..): ${g}`);
        break;
      }
    }
  }
  const action = value['action'];
  if (!isRecord(action)) {
    errors.push('action must be an object');
  } else {
    if (action['type'] !== 'task') {
      errors.push('action.type must be "task" (the only v1 action)');
    }
    const label = action['label'];
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push('action.label is required');
    } else if (label.length > MAX_LABEL_LENGTH) {
      errors.push(`action.label exceeds ${MAX_LABEL_LENGTH} characters`);
    }
  }
  let debounceMs = DEFAULT_DEBOUNCE_MS;
  const rawDebounce = value['debounceMs'];
  if (rawDebounce !== undefined) {
    if (typeof rawDebounce !== 'number' || !Number.isFinite(rawDebounce)) {
      errors.push('debounceMs must be a number');
    } else {
      debounceMs = Math.round(rawDebounce);
      if (debounceMs < MIN_DEBOUNCE_MS) debounceMs = MIN_DEBOUNCE_MS;
      if (debounceMs > MAX_DEBOUNCE_MS) debounceMs = MAX_DEBOUNCE_MS;
    }
  }
  const enabled = value['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  if (errors.length > 0) return { rule: null, errors };
  return {
    rule: {
      id,
      name: (name as string).trim(),
      globs: (globs as string[]).map((g) => g.trim()),
      action: {
        type: 'task',
        label: ((action as Record<string, unknown>)['label'] as string).trim(),
      },
      debounceMs,
      enabled: enabled === undefined ? true : (enabled as boolean),
    },
    errors: [],
  };
}

/** Parse a watch.json document: { version: 1, rules: WatchRule[] }. */
export function parseWatchFile(text: string): { rules: WatchRule[]; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { rules: [], errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  if (!isRecord(doc) || !Array.isArray(doc['rules'])) {
    return { rules: [], errors: ['watch file must be an object with a rules array'] };
  }
  const rules: WatchRule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of doc['rules'] as unknown[]) {
    const v = validateRule(raw);
    if (!v.rule) {
      errors.push(...v.errors);
      continue;
    }
    if (seen.has(v.rule.id)) {
      errors.push(`duplicate rule id: ${v.rule.id}`);
      continue;
    }
    seen.add(v.rule.id);
    rules.push(v.rule);
  }
  return { rules, errors };
}
