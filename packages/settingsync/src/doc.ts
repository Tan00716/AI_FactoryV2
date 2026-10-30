/**
 * Sync document validation and export (R7-#10).
 *
 * Fail-closed everywhere: an invalid shape, an oversize payload, an
 * unknown section, or a secret-pattern hit is rejected before anything
 * is written or served. Values are compared with JSON canonical form
 * (stable key order), never with reference equality.
 */
import { SECRET_PATTERNS } from '@ai-factory/security';
import type { Sections, SectionValue, SyncDoc } from './types.js';

export const SYNC_FORMAT = 'ai-factory-settings-sync';
export const SYNC_VERSION = 1;
export const MAX_DOC_BYTES = 1_000_000;
export const MAX_SECTIONS = 32;
export const MAX_KEYS_PER_SECTION = 1000;

/** Sections the server knows how to read and write (v1). */
export const KNOWN_SECTIONS: readonly string[] = ['keybindings', 'rules-global'];

export function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null) return true;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

/** Canonical JSON: object keys sorted, so equality is order-free. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Names of secret patterns matching the serialized document. */
export function findSecretHits(serialized: string): string[] {
  const hits: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(serialized)) hits.push(p.name);
  }
  return hits;
}

export interface DocValidation {
  ok: boolean;
  errors: string[];
  doc: SyncDoc | null;
}

/** Validate an untrusted import document. Returns the typed doc only
 * when every check passes; otherwise errors explain each failure. */
export function validateSyncDoc(raw: unknown): DocValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['document must be a JSON object'], doc: null };
  }
  const d = raw as Record<string, unknown>;
  if (d['format'] !== SYNC_FORMAT) errors.push(`format must be ${SYNC_FORMAT}`);
  if (d['version'] !== SYNC_VERSION) errors.push(`version must be ${SYNC_VERSION}`);
  if (typeof d['exportedAt'] !== 'string' || Number.isNaN(Date.parse(d['exportedAt']))) {
    errors.push('exportedAt must be an ISO timestamp string');
  }
  if (!d['sections'] || typeof d['sections'] !== 'object' || Array.isArray(d['sections'])) {
    errors.push('sections must be an object');
  } else {
    const sections = d['sections'] as Record<string, unknown>;
    const names = Object.keys(sections);
    if (names.length > MAX_SECTIONS) errors.push(`at most ${MAX_SECTIONS} sections`);
    for (const name of names) {
      if (!KNOWN_SECTIONS.includes(name)) {
        errors.push(`unknown section: ${name}`);
        continue;
      }
      const sec = sections[name];
      if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
        errors.push(`section ${name} must be an object`);
        continue;
      }
      const keys = Object.keys(sec as SectionValue);
      if (keys.length > MAX_KEYS_PER_SECTION) {
        errors.push(`section ${name} has too many keys (max ${MAX_KEYS_PER_SECTION})`);
      }
      for (const k of keys) {
        if (!isJsonValue((sec as SectionValue)[k])) errors.push(`section ${name}.${k} is not JSON`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, doc: null };
  let serialized = '';
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, errors: ['document is not serializable'], doc: null };
  }
  if (serialized.length > MAX_DOC_BYTES) {
    return { ok: false, errors: [`document too large (max ${MAX_DOC_BYTES} bytes)`], doc: null };
  }
  const hits = findSecretHits(serialized);
  if (hits.length > 0) {
    return { ok: false, errors: [`document matches secret pattern(s): ${hits.join(', ')}; secrets are never synced`], doc: null };
  }
  return { ok: true, errors: [], doc: raw as unknown as SyncDoc };
}

/** Build an export document from the current sections. Refuses (throws)
 * on oversize input or a secret-pattern hit — an export must never
 * carry a credential, even if one crept into a settings file. */
export function createExport(sections: Sections, now: () => number = Date.now): SyncDoc {
  const doc: SyncDoc = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    exportedAt: new Date(now()).toISOString(),
    sections,
  };
  const v = validateSyncDoc(doc);
  if (!v.ok) throw new Error(`cannot export settings: ${v.errors.join('; ')}`);
  return doc;
}

/** Validate a current-state sections map (same rules as a document's
 * sections, minus the envelope). Used by the route before diffing. */
export function validateSections(sections: unknown): string[] {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    return ['sections must be an object'];
  }
  const errors: string[] = [];
  for (const [name, sec] of Object.entries(sections as Record<string, unknown>)) {
    if (!KNOWN_SECTIONS.includes(name)) errors.push(`unknown section: ${name}`);
    else if (!sec || typeof sec !== 'object' || Array.isArray(sec)) errors.push(`section ${name} must be an object`);
  }
  return errors;
}
