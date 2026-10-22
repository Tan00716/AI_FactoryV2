/**
 * SSR template definition, validation, built-ins, and matching.
 *
 * A template is a JSON-serializable structural query: kind, name regex,
 * modifier constraints, type-annotation constraints, arity/size bounds,
 * enclosing scope, and file pattern. Matching is purely structural —
 * it never looks at identifier text outside the extracted node fields,
 * which is exactly why renaming `count` in one function cannot touch
 * the `count` in another.
 */

import type { SsrMatch, SsrTemplate, StructNode, StructNodeKind } from './types.js';
import { extractStructNodes } from './scanner.js';

export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function safeRegex(source: string): RegExp | null {
  if (typeof source !== 'string' || source.length === 0 || source.length > 500) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const KINDS: StructNodeKind[] = ['class', 'method', 'function', 'variable', 'interface', 'type', 'enum'];
const REPLACE_OPS = ['rename', 'replaceRange', 'addModifier'] as const;

function strList(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim() || x.length > maxLen) return null;
    out.push(x.trim());
  }
  return out;
}

function optInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

/**
 * Strict, fail-closed template validation. Returns errors; never throws
 * on hostile input, never guesses.
 */
export function validateTemplate(input: unknown): { template: SsrTemplate | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { template: null, errors: ['template must be an object'] };
  const t = input as Record<string, unknown>;

  if (typeof t.id !== 'string' || !TEMPLATE_ID_RE.test(t.id)) {
    errors.push('id must match [a-z0-9][a-z0-9-]{0,63}');
  }
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 120) {
    errors.push('name must be a non-empty string (max 120)');
  }
  if (t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 500)) {
    errors.push('description must be a string (max 500)');
  }
  if (t.version !== undefined && t.version !== 1) errors.push('version must be 1');
  if (!isRecord(t.search)) errors.push('search must be an object');

  const s = (isRecord(t.search) ? t.search : {}) as Record<string, unknown>;
  let kinds: StructNodeKind[] | undefined;
  if (s.kind !== undefined) {
    const list = Array.isArray(s.kind) ? s.kind : [s.kind];
    if (list.length === 0 || list.length > KINDS.length || !list.every((k) => typeof k === 'string' && (KINDS as string[]).includes(k))) {
      errors.push(`search.kind must be one or more of ${KINDS.join(',')}`);
    } else {
      kinds = list as StructNodeKind[];
    }
  }
  for (const key of ['namePattern', 'typePattern', 'enclosing', 'filePattern'] as const) {
    if (s[key] !== undefined && safeRegex(s[key] as string) === null) {
      errors.push(`search.${key} must be a valid regex (1..500 chars)`);
    }
  }
  const modifiers = s.modifiers === undefined ? undefined : strList(s.modifiers, 8, 24);
  if (s.modifiers !== undefined && modifiers === null) errors.push('search.modifiers must be a string array (max 8, 24 chars each)');
  const modifiersAbsent = s.modifiersAbsent === undefined ? undefined : strList(s.modifiersAbsent, 8, 24);
  if (s.modifiersAbsent !== undefined && modifiersAbsent === null) errors.push('search.modifiersAbsent must be a string array (max 8, 24 chars each)');
  if (s.hasTypeAnnotation !== undefined && typeof s.hasTypeAnnotation !== 'boolean') {
    errors.push('search.hasTypeAnnotation must be boolean');
  }
  const minParams = optInt(s.minParams, 0, 100);
  const maxParams = optInt(s.maxParams, 0, 100);
  const minLines = optInt(s.minLines, 1, 100000);
  const maxLines = optInt(s.maxLines, 1, 100000);
  if (minParams === null) errors.push('search.minParams must be an integer 0..100');
  if (maxParams === null) errors.push('search.maxParams must be an integer 0..100');
  if (minLines === null) errors.push('search.minLines must be an integer 1..100000');
  if (maxLines === null) errors.push('search.maxLines must be an integer 1..100000');
  if (typeof minParams === 'number' && typeof maxParams === 'number' && minParams > maxParams) {
    errors.push('search.minParams must not exceed search.maxParams');
  }
  if (typeof minLines === 'number' && typeof maxLines === 'number' && minLines > maxLines) {
    errors.push('search.minLines must not exceed search.maxLines');
  }

  let replace: SsrTemplate['replace'];
  if (t.replace !== undefined) {
    if (!isRecord(t.replace)) {
      errors.push('replace must be an object');
    } else {
      const r = t.replace as Record<string, unknown>;
      if (typeof r.op !== 'string' || !(REPLACE_OPS as readonly string[]).includes(r.op)) {
        errors.push(`replace.op must be one of ${REPLACE_OPS.join(',')}`);
      } else if (r.op === 'rename') {
        if (typeof r.to !== 'string' || !/^[A-Za-z_$][\w$]{0,63}$/.test(r.to)) {
          errors.push('replace.to must be a valid identifier (max 64 chars)');
        } else {
          replace = { op: 'rename', to: r.to };
        }
      } else if (r.op === 'replaceRange') {
        if (typeof r.text !== 'string' || !r.text || r.text.length > 20000) {
          errors.push('replace.text must be a non-empty string (max 20000 chars)');
        } else {
          replace = { op: 'replaceRange', text: r.text };
        }
      } else if (r.op === 'addModifier') {
        if (typeof r.modifier !== 'string' || !/^(private|protected|public|static|async|readonly|override|abstract)$/.test(r.modifier)) {
          errors.push('replace.modifier must be one of private|protected|public|static|async|readonly|override|abstract');
        } else {
          replace = { op: 'addModifier', modifier: r.modifier };
        }
      }
    }
  }

  if (t.asInspection !== undefined && typeof t.asInspection !== 'boolean') {
    errors.push('asInspection must be boolean');
  }
  if (t.severity !== undefined && !['info', 'warning', 'error'].includes(t.severity as string)) {
    errors.push('severity must be info|warning|error');
  }

  if (errors.length > 0) return { template: null, errors };
  return {
    template: {
      id: t.id as string,
      name: (t.name as string).trim(),
      description: typeof t.description === 'string' ? t.description : undefined,
      version: 1,
      search: {
        ...(kinds ? { kind: kinds.length === 1 ? kinds[0] : kinds } : {}),
        ...(typeof s.namePattern === 'string' ? { namePattern: s.namePattern } : {}),
        ...(modifiers ? { modifiers } : {}),
        ...(modifiersAbsent ? { modifiersAbsent } : {}),
        ...(typeof s.hasTypeAnnotation === 'boolean' ? { hasTypeAnnotation: s.hasTypeAnnotation } : {}),
        ...(typeof s.typePattern === 'string' ? { typePattern: s.typePattern } : {}),
        ...(typeof minParams === 'number' ? { minParams } : {}),
        ...(typeof maxParams === 'number' ? { maxParams } : {}),
        ...(typeof minLines === 'number' ? { minLines } : {}),
        ...(typeof maxLines === 'number' ? { maxLines } : {}),
        ...(typeof s.enclosing === 'string' ? { enclosing: s.enclosing } : {}),
        ...(typeof s.filePattern === 'string' ? { filePattern: s.filePattern } : {}),
      },
      ...(replace ? { replace } : {}),
      ...(typeof t.asInspection === 'boolean' ? { asInspection: t.asInspection } : {}),
      ...(typeof t.severity === 'string' ? { severity: t.severity as SsrTemplate['severity'] } : {}),
    },
    errors: [],
  };
}

function kindList(t: SsrTemplate): StructNodeKind[] | undefined {
  if (!t.search.kind) return undefined;
  return Array.isArray(t.search.kind) ? t.search.kind : [t.search.kind];
}

/** True when the node satisfies every constraint in the template. */
export function nodeMatches(t: SsrTemplate, node: StructNode): boolean {
  const kinds = kindList(t);
  if (kinds && !kinds.includes(node.kind)) return false;
  if (t.search.namePattern && !safeRegex(t.search.namePattern)!.test(node.name)) return false;
  if (t.search.modifiers && !t.search.modifiers.every((m) => node.modifiers.includes(m))) return false;
  if (t.search.modifiersAbsent && t.search.modifiersAbsent.some((m) => node.modifiers.includes(m))) return false;
  if (t.search.hasTypeAnnotation === true && !node.typeAnnotation) return false;
  if (t.search.hasTypeAnnotation === false && node.typeAnnotation) return false;
  if (t.search.typePattern && !(node.typeAnnotation && safeRegex(t.search.typePattern)!.test(node.typeAnnotation))) return false;
  const pc = node.params.length;
  if (t.search.minParams !== undefined && pc < t.search.minParams) return false;
  if (t.search.maxParams !== undefined && pc > t.search.maxParams) return false;
  const lc = node.endLine - node.startLine + 1;
  if (t.search.minLines !== undefined && lc < t.search.minLines) return false;
  if (t.search.maxLines !== undefined && lc > t.search.maxLines) return false;
  if (t.search.enclosing && !(node.parent && safeRegex(t.search.enclosing)!.test(node.parent))) return false;
  if (t.search.filePattern && !safeRegex(t.search.filePattern)!.test(node.file)) return false;
  return true;
}

export interface ScannedInput {
  /** Root-relative posix path. */
  file: string;
  text: string;
}

/** Scan files and return one match per satisfying node (deterministic order). */
export function findMatches(files: ScannedInput[], template: SsrTemplate): SsrMatch[] {
  const out: SsrMatch[] = [];
  for (const f of files) {
    let nodes: StructNode[];
    try {
      nodes = extractStructNodes(f.file, f.text);
    } catch {
      continue; // one bad file never aborts the search
    }
    for (const n of nodes) {
      if (!nodeMatches(template, n)) continue;
      out.push({
        file: n.file,
        kind: n.kind,
        name: n.name,
        startLine: n.startLine,
        endLine: n.endLine,
        modifiers: n.modifiers,
        snippet: n.snippet,
        parent: n.parent,
        templateId: template.id,
      });
    }
  }
  return out;
}

/** Built-in templates (ids are stable; also used by the desktop UI). */
export function builtinTemplates(): SsrTemplate[] {
  const mk = (t: SsrTemplate): SsrTemplate => {
    const { template, errors } = validateTemplate(t);
    if (!template || errors.length > 0) throw new Error(`builtin template invalid: ${t.id}: ${errors.join('; ')}`);
    return template;
  };
  return [
    mk({
      id: 'public-methods',
      name: 'All public methods',
      description: 'Methods not marked private or protected (TS default visibility is public).',
      version: 1,
      search: { kind: 'method', modifiersAbsent: ['private', 'protected'] },
    }),
    mk({
      id: 'typed-variables',
      name: 'Typed variables',
      description: 'Variables carrying a declared type annotation, e.g. `let x: number`.',
      version: 1,
      search: { kind: 'variable', hasTypeAnnotation: true },
    }),
    mk({
      id: 'long-functions',
      name: 'Long functions/methods',
      description: 'Functions or methods spanning 30+ lines.',
      version: 1,
      search: { kind: ['function', 'method'], minLines: 30 },
    }),
    mk({
      id: 'async-methods',
      name: 'Async methods',
      description: 'Methods declared async.',
      version: 1,
      search: { kind: 'method', modifiers: ['async'] },
    }),
  ];
}

export function builtinTemplateById(id: string): SsrTemplate | null {
  return builtinTemplates().find((t) => t.id === id) ?? null;
}
