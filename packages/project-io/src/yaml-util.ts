/**
 * Minimal hand-written YAML serializer (zero external dependencies).
 *
 * Companion to the hand-written subset parser in @ai-factory/policy
 * (`parseYaml`): everything this serializer emits must parse back.
 * Only the subset the parser supports is emitted: nested maps, block
 * lists, and plain/quoted scalars. Multi-line strings are emitted as
 * double-quoted with `\n` escapes (the parser does not support literal
 * blocks).
 */
import { parseYaml, YamlMap, YamlNode } from '@ai-factory/policy';

export { parseYaml, YamlParseError } from '@ai-factory/policy';
export type { YamlMap, YamlNode, YamlScalar, YamlList } from '@ai-factory/policy';

function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/[\n\r\t]/.test(s)) return true;
  if (/^(true|false|null|~)$/i.test(s)) return true;
  if (/^-?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(s)) return true;
  // Characters that would confuse the minimal parser or change meaning.
  if (/[:#\[\]{}&*!|>'"%@`,?\-]/.test(s[0] ?? '')) return true;
  if (/[#:]/.test(s)) return true;
  if (/^\- /.test(s) || s === '-') return true;
  return false;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function scalar(node: YamlNode): string {
  if (node === null) return 'null';
  if (typeof node === 'boolean') return node ? 'true' : 'false';
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) return 'null';
    return String(node);
  }
  const s = String(node);
  return needsQuotes(s) ? quote(s) : s;
}

function isMap(n: YamlNode): n is YamlMap {
  return typeof n === 'object' && n !== null && !Array.isArray(n);
}

/** Serialize a YAML node to text (2-space indent). */
export function stringifyYaml(node: YamlNode, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(node)) {
    // Empty collections serialize as an empty block: `key:` followed by
    // nothing parses back as null via the minimal parser (flow `[]`/`{}`
    // are NOT supported by it), so export.ts omits empty values instead.
    if (node.length === 0) return '';
    return node
      .map((item) => {
        if (isMap(item) || Array.isArray(item)) {
          const nested = stringifyYaml(item, indent + 2);
          const lines = nested.split('\n');
          return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join('\n')}`;
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (isMap(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) return '';
    return keys
      .map((k) => {
        const key = needsQuotes(k) ? quote(k) : k;
        const v = node[k];
        if (isMap(v) || (Array.isArray(v) && v.length > 0)) {
          return `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
        }
        return `${pad}${key}: ${scalar(v)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(node)}`;
}

/** Serialize a top-level document (adds a trailing newline). */
export function stringifyYamlDoc(node: YamlNode): string {
  return `${stringifyYaml(node, 0)}\n`;
}
