/**
 * Deterministic template parser/expander for snippet bodies.
 *
 * Grammar: $1 / ${1:default} / $0 / ${NAME} (builtin vars) / \$ escape.
 * Nested placeholders are rejected: a '${' or '$' + digit inside a
 * placeholder default is a parse error (fail-closed, no guessing).
 */
import type { ExpandedSnippet, SnippetDef, TemplateSegment } from './types.js';
import { BUILTIN_VARIABLES } from './types.js';

export class SnippetTemplateError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message);
    this.name = 'SnippetTemplateError';
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isVarChar(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
}

/** Parse a template body into segments. Throws SnippetTemplateError. */
export function parseTemplate(body: string): TemplateSegment[] {
  const segs: TemplateSegment[] = [];
  const text: string[] = [];
  const flush = (): void => {
    if (text.length > 0) {
      segs.push({ kind: 'text', text: text.join('') });
      text.length = 0;
    }
  };
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < n && body[i + 1] === '$') {
      text.push('$');
      i += 2;
      continue;
    }
    if (ch !== '$') {
      text.push(ch);
      i += 1;
      continue;
    }
    // '$' at end -> literal.
    if (i + 1 >= n) {
      text.push('$');
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (isDigit(next)) {
      flush();
      let j = i + 1;
      while (j < n && isDigit(body[j])) j++;
      segs.push({ kind: 'tabstop', index: Number(body.slice(i + 1, j)) });
      i = j;
      continue;
    }
    if (next === '{') {
      const close = findPlaceholderClose(body, i + 2);
      if (close < 0) {
        throw new SnippetTemplateError('unterminated ${...}', i);
      }
      const inner = body.slice(i + 2, close);
      const colon = inner.indexOf(':');
      flush();
      if (colon < 0) {
        // ${NAME} — must be a known builtin variable.
        const name = inner;
        if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
          throw new SnippetTemplateError(`invalid variable syntax: \${${inner}}`, i);
        }
        segs.push({ kind: 'variable', name });
      } else {
        const idxStr = inner.slice(0, colon);
        const defaultText = inner.slice(colon + 1);
        if (!/^\d+$/.test(idxStr)) {
          throw new SnippetTemplateError(`invalid placeholder index: ${idxStr}`, i);
        }
        if (defaultText.includes('${') || /\$\d/.test(defaultText)) {
          throw new SnippetTemplateError('nested placeholders are not supported', i);
        }
        segs.push({ kind: 'placeholder', index: Number(idxStr), defaultText });
      }
      i = close + 1;
      continue;
    }
    // '$' followed by anything else: literal dollar.
    text.push('$');
    i += 1;
  }
  flush();
  return segs;
}

/** Find the matching '}' for a '${' starting at `start` (index after '${'). */
function findPlaceholderClose(body: string, start: number): number {
  for (let k = start; k < body.length; k++) {
    if (body[k] === '}') return k;
  }
  return -1;
}

export interface VariableValues {
  /** Values for builtin variables; missing ones fall back to defaults. */
  FILENAME?: string;
  DATE?: string;
  TIME?: string;
}

function defaultVarValue(name: string, vars: VariableValues): string {
  switch (name) {
    case 'FILENAME':
      return vars.FILENAME ?? 'untitled';
    case 'DATE':
      return vars.DATE ?? new Date().toISOString().slice(0, 10);
    case 'TIME':
      return vars.TIME ?? new Date().toISOString().slice(11, 16);
    default:
      return '';
  }
}

function isKnownVariable(name: string): boolean {
  return (BUILTIN_VARIABLES as readonly string[]).includes(name);
}

/**
 * Expand variables in a snippet body; tab stops/placeholders are preserved
 * verbatim (the editor consumes them). Unknown ${NAME} variables are
 * rejected by validate(); here an unknown name yields an empty string so
 * expansion is total but never guesses content.
 */
export function expandSnippet(def: SnippetDef, vars: VariableValues = {}): ExpandedSnippet {
  const segs = parseTemplate(def.body);
  const out: string[] = [];
  const seen: number[] = [];
  for (const seg of segs) {
    switch (seg.kind) {
      case 'text':
        out.push(seg.text);
        break;
      case 'tabstop':
        out.push(seg.index === 0 ? '$0' : `$${seg.index}`);
        if (!seen.includes(seg.index)) seen.push(seg.index);
        break;
      case 'placeholder':
        out.push(`\${${seg.index}:${seg.defaultText}}`);
        if (!seen.includes(seg.index)) seen.push(seg.index);
        break;
      case 'variable':
        out.push(isKnownVariable(seg.name) ? defaultVarValue(seg.name, vars) : '');
        break;
    }
  }
  // Jump order: 1..n ascending, $0 last.
  const tabOrder = seen
    .filter((x) => x > 0)
    .sort((a, b) => a - b)
    .concat(seen.includes(0) ? [0] : []);
  return { text: out.join(''), tabOrder, preview: previewSnippet(def, vars) };
}

/** Plain-text preview: placeholders replaced by their defaults, vars filled. */
export function previewSnippet(def: SnippetDef, vars: VariableValues = {}): string {
  const segs = parseTemplate(def.body);
  const out: string[] = [];
  for (const seg of segs) {
    switch (seg.kind) {
      case 'text':
        out.push(seg.text);
        break;
      case 'tabstop':
        out.push('');
        break;
      case 'placeholder':
        out.push(seg.defaultText);
        break;
      case 'variable':
        out.push(isKnownVariable(seg.name) ? defaultVarValue(seg.name, vars) : '');
        break;
    }
  }
  return out.join('');
}

/** True when a snippet's scope list matches the given language id. */
export function scopeMatches(scope: string[], languageId: string): boolean {
  const lang = languageId.trim().toLowerCase();
  return scope.some((s) => {
    const v = s.trim().toLowerCase();
    return v === '*' || v === lang;
  });
}
