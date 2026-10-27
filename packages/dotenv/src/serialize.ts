/**
 * Roundtrip .env writer (round-6 task R6-A8).
 *
 * applyEnvOps rewrites ONLY the lines it must: a `set` rewrites the
 * first entry line for its key (keeping an `export ` prefix when the
 * line had one) and drops any later duplicate lines for that key; a
 * `delete` drops every entry line for its key; a `set` for an absent
 * key appends one `KEY=value` line at the end. Every other line —
 * comments, blanks, untouched entries, invalid lines — is preserved
 * byte-for-byte. The result always ends with a single trailing newline
 * when it is non-empty.
 */
import { parseDotEnv } from './parse.ts';
import type { DotEnvLine, DotEnvOp } from './types.ts';

/** Quote a value only when a bare value would not survive a re-parse. */
export function quoteEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value) || value !== value.trim() || value === '') {
    if (value === '') return '';
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return value;
}

export function applyEnvOps(text: string, ops: DotEnvOp[]): string {
  const doc = parseDotEnv(text);
  const sets = new Map<string, string>();
  const deletes = new Set<string>();
  for (const op of ops) {
    if (op.type === 'set') {
      sets.set(op.key, op.value);
      deletes.delete(op.key);
    } else {
      deletes.add(op.key);
      sets.delete(op.key);
    }
  }
  const rewritten = new Set<string>();
  const out: DotEnvLine[] = [];
  for (const line of doc.lines) {
    if (line.kind !== 'entry' || line.key === undefined) {
      out.push(line);
      continue;
    }
    const key = line.key;
    if (deletes.has(key)) continue;
    if (sets.has(key)) {
      if (rewritten.has(key)) continue; // collapse duplicates to one line
      rewritten.add(key);
      const prefix = line.exported ? 'export ' : '';
      out.push({
        kind: 'entry',
        raw: `${prefix}${key}=${quoteEnvValue(sets.get(key) as string)}`,
        key,
        value: sets.get(key),
        exported: line.exported,
      });
      continue;
    }
    out.push(line);
  }
  for (const [key, value] of sets) {
    if (!rewritten.has(key)) {
      out.push({ kind: 'entry', raw: `${key}=${quoteEnvValue(value)}`, key, value });
    }
  }
  if (out.length === 0) return '';
  return out.map((l) => l.raw).join('\n') + '\n';
}

/** Keys present more than once in a parsed document (duplicate warning). */
export function duplicateKeys(doc: ReturnType<typeof parseDotEnv>): string[] {
  return doc.entries.filter((e) => e.occurrences > 1).map((e) => e.key);
}
