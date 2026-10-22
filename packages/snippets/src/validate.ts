/**
 * Fail-closed validation for snippets.json payloads.
 *
 * Returns a list of human-readable issues; an empty list means valid.
 * Validation never throws and never guesses — unknown fields are ignored
 * (forward-compatible), malformed entries are rejected item by item.
 */
import { parseTemplate, SnippetTemplateError } from './template.js';
import type { SnippetDef } from './types.js';
import {
  MAX_PLACEHOLDER_INDEX,
  MAX_SNIPPET_BODY_BYTES,
  MAX_SNIPPETS_PER_FILE,
} from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ValidatedSnippets {
  issues: string[];
  snippets: SnippetDef[];
}

/** Validate the 'snippets' value of a snippets.json payload. */
export function validateSnippets(value: unknown): ValidatedSnippets {
  const issues: string[] = [];
  if (!Array.isArray(value)) {
    return { issues: ['snippets must be an array'], snippets: [] };
  }
  if (value.length > MAX_SNIPPETS_PER_FILE) {
    return {
      issues: [`too many snippets (${value.length} > ${MAX_SNIPPETS_PER_FILE})`],
      snippets: [],
    };
  }
  const seen = new Set<string>();
  const snippets: SnippetDef[] = [];
  for (let idx = 0; idx < value.length; idx++) {
    const label = `snippets[${idx}]`;
    const raw = value[idx];
    if (!isRecord(raw)) {
      issues.push(`${label}: must be an object`);
      continue;
    }
    const itemIssues: string[] = [];
    const id = raw['id'];
    const trigger = raw['trigger'];
    const scope = raw['scope'];
    const body = raw['body'];
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      itemIssues.push('id must match [a-z0-9][a-z0-9_:.-]{0,63}');
    } else if (seen.has(id)) {
      itemIssues.push(`duplicate id "${id}"`);
    }
    if (typeof trigger !== 'string' || trigger.trim().length === 0 || trigger.length > 64) {
      itemIssues.push('trigger must be a non-empty string (<=64 chars)');
    }
    if (
      !Array.isArray(scope) ||
      scope.length === 0 ||
      scope.some((s) => typeof s !== 'string' || s.trim().length === 0 || s.length > 32)
    ) {
      itemIssues.push('scope must be a non-empty array of language ids (or "*")');
    }
    const description = raw['description'];
    if (description !== undefined && (typeof description !== 'string' || description.length > 256)) {
      itemIssues.push('description must be a string (<=256 chars)');
    }
    if (typeof body !== 'string' || body.length === 0) {
      itemIssues.push('body must be a non-empty string');
    } else if (Buffer.byteLength(body, 'utf8') > MAX_SNIPPET_BODY_BYTES) {
      itemIssues.push(`body exceeds ${MAX_SNIPPET_BODY_BYTES} bytes`);
    } else {
      try {
        const segs = parseTemplate(body);
        for (const seg of segs) {
          if ((seg.kind === 'tabstop' || seg.kind === 'placeholder') && seg.index > MAX_PLACEHOLDER_INDEX) {
            throw new SnippetTemplateError(`placeholder index ${seg.index} too large`, 0);
          }
        }
      } catch (e) {
        itemIssues.push(`body: ${(e as Error).message}`);
      }
    }
    if (itemIssues.length > 0) {
      for (const m of itemIssues) issues.push(`${label}: ${m}`);
      continue;
    }
    seen.add(id as string);
    snippets.push({
      id: id as string,
      trigger: (trigger as string).trim(),
      description: typeof description === 'string' ? description : undefined,
      scope: (scope as string[]).map((s) => s.trim()),
      body: body as string,
    });
  }
  return { issues, snippets };
}
