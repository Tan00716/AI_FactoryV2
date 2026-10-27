/**
 * Managed-rule level store (round-6 R6-A6). Pure in-memory operations plus
 * atomic file persistence (tmp + rename) for one level's rules.json.
 *
 * The store file is a single JSON document { version: 1, rules: [...] }.
 * A missing file reads as empty; a corrupt file reads as empty too (never
 * trusted) and is replaced on the next successful write — the same
 * fail-open-read policy as the bookmarks store. Writes are fail-closed:
 * oversize payloads and invalid rules are rejected before touching disk.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_RULES_PER_LEVEL,
  MAX_STORE_BYTES,
  type LevelStore,
  type ManagedRule,
} from './types.js';
import { sameName, sortRules, validateRuleContent, validateRuleName, validateRuleOrder } from './validate.js';

export function emptyStore(): LevelStore {
  return { version: 1, rules: [] };
}

export function parseStore(raw: string): LevelStore {
  try {
    const parsed = JSON.parse(raw) as Partial<LevelStore>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.rules)) {
      const rules = parsed.rules.filter(
        (r): r is ManagedRule =>
          !!r && typeof r === 'object' &&
          typeof (r as ManagedRule).id === 'string' &&
          typeof (r as ManagedRule).name === 'string' &&
          typeof (r as ManagedRule).content === 'string' &&
          typeof (r as ManagedRule).enabled === 'boolean' &&
          typeof (r as ManagedRule).order === 'number',
      );
      return { version: 1, rules: sortRules(rules) };
    }
  } catch {
    // Corrupt: fall through to empty.
  }
  return emptyStore();
}

export function readStoreFile(path: string): LevelStore {
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.length > MAX_STORE_BYTES) return emptyStore();
    return parseStore(raw);
  } catch {
    return emptyStore();
  }
}

export function writeStoreFile(path: string, store: LevelStore): void {
  const payload = JSON.stringify(store);
  if (payload.length > MAX_STORE_BYTES) throw new Error('rule store too large');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, path);
}

export interface AddInput {
  name: string;
  content: string;
  scope: 'global' | 'project';
  order?: number;
}

export function addRule(
  existing: ManagedRule[],
  input: AddInput,
  makeId: () => string,
  now: () => number,
): { rule: ManagedRule | null; issues: string[] } {
  const issues = [
    ...validateRuleName(input.name),
    ...validateRuleContent(input.content),
    ...validateRuleOrder(input.order),
  ];
  if (existing.length >= MAX_RULES_PER_LEVEL) {
    issues.push(`rule limit reached (${MAX_RULES_PER_LEVEL} per level)`);
  }
  if (existing.some((r) => sameName(r.name, input.name))) {
    issues.push(`a rule named "${input.name}" already exists at this level`);
  }
  if (issues.length > 0) return { rule: null, issues };
  const ts = now();
  const rule: ManagedRule = {
    id: makeId(),
    name: input.name,
    scope: input.scope,
    content: input.content,
    enabled: true,
    order: input.order ?? (existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.order)) + 1),
    createdAt: ts,
    updatedAt: ts,
  };
  return { rule, issues: [] };
}

export interface PatchInput {
  name?: string;
  content?: string;
  enabled?: boolean;
  order?: number;
}

export function patchRule(
  existing: ManagedRule[],
  id: string,
  patch: PatchInput,
  now: () => number,
): { rule: ManagedRule | null; issues: string[] } {
  const target = existing.find((r) => r.id === id);
  if (!target) return { rule: null, issues: ['rule not found'] };
  const issues: string[] = [];
  if (patch.name !== undefined) {
    issues.push(...validateRuleName(patch.name));
    if (existing.some((r) => r.id !== id && sameName(r.name, patch.name as string))) {
      issues.push(`a rule named "${patch.name}" already exists at this level`);
    }
  }
  if (patch.content !== undefined) issues.push(...validateRuleContent(patch.content));
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    issues.push('enabled must be a boolean');
  }
  if (patch.order !== undefined) issues.push(...validateRuleOrder(patch.order));
  if (issues.length > 0) return { rule: null, issues };
  const updated: ManagedRule = {
    ...target,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    updatedAt: now(),
  };
  return { rule: updated, issues: [] };
}

/**
 * Reorder a level: ids must be an exact permutation of the level's managed
 * ids (no drops, no duplicates, no strangers). Orders are reassigned 0..n-1
 * in the given sequence.
 */
export function reorderRules(
  existing: ManagedRule[],
  ids: string[],
  now: () => number,
): { rules: ManagedRule[] | null; issues: string[] } {
  const have = new Set(existing.map((r) => r.id));
  const issues: string[] = [];
  if (ids.length !== existing.length) issues.push('ids must list every rule at this level exactly once');
  if (new Set(ids).size !== ids.length) issues.push('ids must not contain duplicates');
  for (const id of ids) {
    if (!have.has(id)) issues.push(`unknown rule id: ${id}`);
  }
  if (issues.length > 0) return { rules: null, issues };
  const ts = now();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const rules = ids.map((id, i) => ({ ...(byId.get(id) as ManagedRule), order: i, updatedAt: ts }));
  return { rules, issues: [] };
}
