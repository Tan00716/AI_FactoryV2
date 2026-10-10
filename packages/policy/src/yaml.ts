/**
 * Minimal hand-written YAML subset parser (spec §98/§99 need it).
 *
 * Supported subset (zero external dependencies):
 *  - indentation-based nested maps (spaces only — tabs are an error)
 *  - block lists (`- item`), incl. lists of inline maps (`- key: value`)
 *  - scalars: quoted/unquoted strings, true/false, null/~, integers, floats
 *  - `#` comments outside quotes; duplicate keys are an error
 *
 * Everything outside this subset throws YamlParseError with a line number.
 */

export type YamlScalar = string | number | boolean | null;
export interface YamlMap {
  [key: string]: YamlNode;
}
export type YamlList = YamlNode[];
export type YamlNode = YamlScalar | YamlMap | YamlList;

export class YamlParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`YAML syntax error at line ${line}: ${message}`);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  num: number;
}

/** Strip a `#` comment that is not inside single/double quotes. */
function stripComment(raw: string): string {
  let single = false;
  let dbl = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !dbl) single = !single;
    else if (c === '"' && !single) dbl = !dbl;
    else if (c === '#' && !single && !dbl) return raw.slice(0, i);
  }
  return raw;
}

/** Single-pass unescape for double-quoted YAML scalars. */
function unescapeDoubleQuoted(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { out.push('\n'); i++; continue; }
      if (n === 'r') { out.push('\r'); i++; continue; }
      if (n === 't') { out.push('\t'); i++; continue; }
      if (n === '\\' || n === '"') { out.push(n); i++; continue; }
      // Unknown escape: keep the backslash literally (YAML would error;
      // the minimal subset stays lenient here).
      out.push('\\');
      continue;
    }
    out.push(s[i]);
  }
  return out.join('');
}

function parseScalar(text: string): YamlScalar {
  const t = text.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    const inner = t.slice(1, -1);
    // Double-quoted scalars process backslash escapes in a single pass so
    // that `\\n` stays a literal backslash + "n" while `\n` is a newline.
    // Single-quoted scalars take the content literally (YAML rule).
    return t.startsWith('"') ? unescapeDoubleQuoted(inner) : inner;
  }
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(t) || /^-?\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/**
 * Split `key: value` on the first colon. Returns null when the line is not
 * a key/value pair (plain scalar, e.g. a list item or a bare string).
 */
function splitKeyValue(text: string): [string, string] | null {
  const idx = text.indexOf(':');
  if (idx < 0) return null;
  const after = text[idx + 1];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  const key = text.slice(0, idx).trim();
  if (key === '' || /[\s#]/.test(key)) return null;
  return [key, text.slice(idx + 1).trim()];
}

function isListItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines: Line[], i: number, indent: number): [YamlNode, number] {
  if (isListItem(lines[i].text)) return parseList(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines: Line[], i: number, indent: number, map: YamlMap = {}): [YamlMap, number] {
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlParseError(ln.num, 'unexpected indentation');
    if (isListItem(ln.text)) throw new YamlParseError(ln.num, 'list item inside a map block');
    const kv = splitKeyValue(ln.text);
    if (!kv) throw new YamlParseError(ln.num, `expected "key: value", got "${ln.text}"`);
    const [key, rest] = kv;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlParseError(ln.num, `duplicate key "${key}"`);
    }
    i++;
    if (rest !== '') {
      map[key] = parseScalar(rest);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [node, ni] = parseBlock(lines, i, lines[i].indent);
      map[key] = node;
      i = ni;
    } else {
      map[key] = null;
    }
  }
  return [map, i];
}

function parseList(lines: Line[], i: number, indent: number): [YamlList, number] {
  const list: YamlList = [];
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlParseError(ln.num, 'unexpected indentation');
    if (!isListItem(ln.text)) break;
    const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
    i++;
    if (rest === '') {
      // Nested block under the dash.
      if (i < lines.length && lines[i].indent > indent) {
        const [node, ni] = parseBlock(lines, i, lines[i].indent);
        list.push(node);
        i = ni;
      } else {
        list.push(null);
      }
    } else if (splitKeyValue(rest)) {
      // Inline map item: `- key: value` — treat as a map at indent+2.
      const itemIndent = indent + 2;
      const virtual: Line = { indent: itemIndent, text: rest, num: ln.num };
      lines.splice(i, 0, virtual);
      const [map, ni] = parseMap(lines, i, itemIndent);
      list.push(map);
      i = ni;
    } else {
      list.push(parseScalar(rest));
    }
  }
  return [list, i];
}

/** Parse a YAML document (minimal subset) or throw YamlParseError. */
export function parseYaml(text: string): YamlNode {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const num = idx + 1;
    if (/\t/.test(raw)) throw new YamlParseError(num, 'tabs are not allowed for indentation');
    const stripped = stripComment(raw);
    if (stripped.trim() === '') return;
    if (stripped.trimStart().startsWith('---')) return; // document marker
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: stripped.trim(), num });
  });
  if (lines.length === 0) return null;
  const [node, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlParseError(lines[next].num, 'unexpected trailing content');
  }
  return node;
}
