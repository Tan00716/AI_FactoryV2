/**
 * .env parser (round-6 task R6-A8).
 *
 * Supported line shapes:
 *   # comment            (kept verbatim)
 *   (blank)              (kept verbatim)
 *   KEY=value            (unquoted; a ` #` starts an inline comment)
 *   KEY="double quoted"  (\n \r \t \\ \" escapes; unknown escapes keep the backslash)
 *   KEY='single quoted'  (literal, no escapes)
 *   export KEY=value     (prefix preserved on rewrite)
 *
 * Deliberately NOT supported in v1 (documented, surfaced as invalid
 * lines instead of silently mangled): multi-line quoted values, and a
 * key with no `=` sign. An invalid line is never dropped by the
 * editor — it is kept byte-for-byte unless the user deletes its key,
 * and it is reported as a warning.
 */
import type { DotEnvEntry, DotEnvLine, DotEnvParseResult } from './types.ts';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

interface ValueParse {
  value?: string;
  error?: string;
}

function parseQuoted(rest: string, quote: '"' | "'"): ValueParse {
  let out = '';
  let i = 1;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === quote) {
      const tail = rest.slice(i + 1).trim();
      if (tail !== '' && !tail.startsWith('#')) {
        return { error: 'unexpected content after closing quote' };
      }
      return { value: out };
    }
    if (quote === '"' && ch === '\\' && i + 1 < rest.length) {
      const esc = rest[i + 1];
      if (esc === 'n') out += '\n';
      else if (esc === 'r') out += '\r';
      else if (esc === 't') out += '\t';
      else if (esc === '\\') out += '\\';
      else if (esc === '"') out += '"';
      else out += '\\' + esc;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { error: 'unclosed quote' };
}

function parseUnquoted(rest: string): string {
  // A '#' starts an inline comment only after whitespace; `KEY=#x`
  // keeps "#x" as the value.
  let end = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '#' && i > 0 && /\s/.test(rest[i - 1])) {
      end = i;
      break;
    }
  }
  return rest.slice(0, end).trim();
}

export function parseDotEnv(text: string): DotEnvParseResult {
  const rawLines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // A trailing newline produces one final empty split element; that is
  // not a document line, it is the file terminator.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '' && text.endsWith('\n')) {
    rawLines.pop();
  }
  const lines: DotEnvLine[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const entryOrder: string[] = [];
  const effective = new Map<string, DotEnvEntry>();

  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === '') {
      lines.push({ kind: 'blank', raw });
      return;
    }
    if (trimmed.startsWith('#')) {
      lines.push({ kind: 'comment', raw });
      return;
    }
    const m = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) {
      const message = raw.includes('=')
        ? 'invalid key name'
        : 'line has no "=" sign';
      lines.push({ kind: 'invalid', raw, error: message });
      errors.push({ line: lineNo, message });
      return;
    }
    const exported = /^\s*export\s+/.test(raw);
    const key = m[2];
    const rest = m[3];
    let value: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const parsed = parseQuoted(rest, rest[0] as '"' | "'");
      if (parsed.error !== undefined || parsed.value === undefined) {
        const message = parsed.error ?? 'unparseable value';
        lines.push({ kind: 'invalid', raw, error: message });
        errors.push({ line: lineNo, message });
        return;
      }
      value = parsed.value;
    } else {
      value = parseUnquoted(rest);
    }
    lines.push({ kind: 'entry', raw, key, value, exported });
    const prev = effective.get(key);
    if (prev) {
      prev.value = value;
      prev.occurrences += 1;
    } else {
      entryOrder.push(key);
      effective.set(key, { key, value, occurrences: 1 });
    }
  });

  return { lines, entries: entryOrder.map((k) => effective.get(k) as DotEnvEntry), errors };
}
