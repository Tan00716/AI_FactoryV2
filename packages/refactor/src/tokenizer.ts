/**
 * @ai-factory/refactor — TS/JS-aware tokenizer.
 *
 * Single pass. Comments and whitespace are dropped (offsets/line/col are
 * still tracked). Strings, template literals (with ${} interpolation),
 * block comments and regex literals (heuristic) become single opaque
 * tokens so the scope walker never mistakes their contents for code.
 *
 * `${` is emitted as a synthetic 'brace-open' and its matching `}` as
 * 'brace-close': for scope purposes both open/close a nested code region,
 * exactly like a plain brace. The tokenizer tracks the template stack
 * internally so the match is always correct.
 */

export type TokenType =
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'string'
  | 'template'
  | 'regex'
  | 'brace-open'
  | 'brace-close'
  | 'paren-open'
  | 'paren-close'
  | 'bracket-open'
  | 'bracket-close'
  | 'punct';

export interface Token {
  type: TokenType;
  value: string;
  /** 0-based offset of the first char, inclusive. */
  start: number;
  /** 0-based offset one past the last char, exclusive. */
  end: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  /** Brace depth *after* this token (template ${ counts as +1). */
  depth: number;
  /** Paren depth *after* this token. */
  pdepth: number;
}

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'get', 'set', 'async',
  'await', 'of', 'from', 'as',
]);

/** After these, a `/` starts a regex (not division). Standard heuristic. */
const REGEX_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '^', '~', '...',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else',
]);

const PUNCTS_3 = ['...', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '?.'];
const PUNCTS_2 = [
  '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
  '^=', '++', '--', '&&', '||', '??', '**', '<<', '>>',
];

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !KEYWORDS.has(name);
}

export function offsetToLineCol(source: string, offset: number): { line: number; col: number } {
  const o = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < o; i++) {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function lineColToOffset(source: string, line: number, col: number): number {
  const lines = source.split('\n');
  const l = Math.max(1, Math.min(line, lines.length));
  const c = Math.max(1, col);
  let off = 0;
  for (let i = 0; i < l - 1; i++) off += lines[i].length + 1;
  return Math.min(source.length, off + c - 1);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let depth = 0;
  let pdepth = 0;
  // Template stack: each entry is true while inside a template literal's
  // static part; interpolation braces are tracked via depthDelta.
  const tmplStack: Array<{ depthAtDollar: number }> = [];
  let prevSignificant = '';

  function push(
    type: TokenType, value: string, start: number, end: number,
    sline: number, scol: number,
  ): void {
    if (type === 'brace-open') depth++;
    if (type === 'paren-open') pdepth++;
    tokens.push({ type, value, start, end, line: sline, col: scol, depth, pdepth });
    if (type === 'brace-close') depth--;
    if (type === 'paren-close') pdepth--;
    prevSignificant = value;
  }

  function advance(k: number): void {
    for (let j = 0; j < k; j++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  }

  function readString(quote: string): string {
    let out = quote;
    advance(1);
    while (i < n) {
      const ch = source[i];
      out += ch;
      if (ch === '\\') {
        advance(1);
        if (i < n) {
          out += source[i];
          advance(1);
        }
        continue;
      }
      advance(1);
      if (ch === quote) break;
      if (ch === '\n' && quote !== '`') break; // unterminated; stop anyway
    }
    return out;
  }

  // Reads one template chunk starting at the backtick or right after a `}`.
  // Returns when hitting an unescaped `${` (chunk ends, interpolation
  // begins) or the closing backtick. Emits template-chunk bookkeeping via
  // the tmplStack handled by the caller.
  function readTemplateChunk(fromBacktick: boolean): { chunk: string; kind: 'interp' | 'end' } {
    let out = fromBacktick ? '`' : '';
    if (fromBacktick) advance(1);
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') {
        out += ch;
        advance(1);
        if (i < n) {
          out += source[i];
          advance(1);
        }
        continue;
      }
      if (ch === '`') {
        out += ch;
        advance(1);
        return { chunk: out, kind: 'end' };
      }
      if (ch === '$' && source[i + 1] === '{') {
        out += '${';
        advance(2);
        return { chunk: out, kind: 'interp' };
      }
      out += ch;
      advance(1);
    }
    return { chunk: out, kind: 'end' };
  }

  function readRegex(): string {
    let out = '/';
    advance(1);
    let inClass = false;
    while (i < n) {
      const ch = source[i];
      out += ch;
      if (ch === '\\') {
        advance(1);
        if (i < n) {
          out += source[i];
          advance(1);
        }
        continue;
      }
      advance(1);
      if (ch === '\n') break;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
    }
    // flags
    while (i < n && /[a-z]/i.test(source[i])) {
      out += source[i];
      advance(1);
    }
    return out;
  }

  while (i < n) {
    const ch = source[i];

    // Inside a template interpolation: a `}` at the interpolation's brace
    // depth closes the interpolation and resumes the template chunk.
    if (tmplStack.length > 0 && ch === '}' && depth === tmplStack[tmplStack.length - 1].depthAtDollar) {
      const s = i;
      const sl = line;
      const sc = col;
      tmplStack.pop();
      advance(1);
      push('brace-close', '}', s, i, sl, sc);
      // resume template chunk (not from backtick)
      const cs = i;
      const csl = line;
      const csc = col;
      const r = readTemplateChunk(false);
      push('template', r.chunk, cs, i, csl, csc);
      if (r.kind === 'interp') {
        const bs = i - 2;
        tmplStack.push({ depthAtDollar: depth });
        push('brace-open', '${', bs, i, line, col - 2);
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    // comments
    if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      advance(j - i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      advance(j - i);
      continue;
    }

    const s = i;
    const sl = line;
    const sc = col;

    // strings
    if (ch === "'" || ch === '"') {
      const v = readString(ch);
      push('string', v, s, i, sl, sc);
      continue;
    }

    // template literal
    if (ch === '`') {
      const r = readTemplateChunk(true);
      push('template', r.chunk, s, i, sl, sc);
      if (r.kind === 'interp') {
        const bs = i - 2;
        tmplStack.push({ depthAtDollar: depth });
        push('brace-open', '${', bs, i, sl, sc + r.chunk.length - 2);
      }
      continue;
    }

    // regex vs division
    if (ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*') {
      if (REGEX_BEFORE.has(prevSignificant)) {
        const v = readRegex();
        push('regex', v, s, i, sl, sc);
        continue;
      }
      // division punct — fall through to punct matching
    }

    // private identifier #x
    if (ch === '#' && /[A-Za-z_$]/.test(source[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const v = source.slice(i, j);
      advance(j - i);
      push('identifier', v, s, i, sl, sc);
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const v = source.slice(i, j);
      advance(j - i);
      push(KEYWORDS.has(v) ? 'keyword' : 'identifier', v, s, i, sl, sc);
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '0' && /[xXbBoO]/.test(source[j + 1] ?? '')) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(source[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(source[j])) j++;
        if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
          j++;
          while (j < n && /[0-9_]/.test(source[j])) j++;
        }
        if (/[eE]/.test(source[j] ?? '') && /[0-9+-]/.test(source[j + 1] ?? '')) {
          j += 2;
          while (j < n && /[0-9_]/.test(source[j])) j++;
        }
      }
      if (/[n]/.test(source[j] ?? '') && !/[eE]/.test(source.slice(i, j))) {
        // bigint suffix, but not after e-notation
        if (/^[0-9_]+$/.test(source.slice(i, j).replace(/_/g, ''))) j++;
      }
      const v = source.slice(i, j);
      advance(j - i);
      push('number', v, s, i, sl, sc);
      continue;
    }

    // multi-char puncts (longest first)
    let matched: string | null = null;
    for (const p of PUNCTS_3) {
      if (source.startsWith(p, i)) {
        // `?.` only when followed by something property-like; else `?` + `.`
        if (p === '?.' && !/[A-Za-z_$0-9({\[]/.test(source[i + 2] ?? '')) continue;
        matched = p;
        break;
      }
    }
    if (!matched) {
      for (const p of PUNCTS_2) {
        if (source.startsWith(p, i)) {
          matched = p;
          break;
        }
      }
    }
    if (matched) {
      let type: TokenType = 'punct';
      if (matched === '{') type = 'brace-open';
      else if (matched === '}') type = 'brace-close';
      else if (matched === '(') type = 'paren-open';
      else if (matched === ')') type = 'paren-close';
      else if (matched === '[') type = 'bracket-open';
      else if (matched === ']') type = 'bracket-close';
      else if (matched === '?.') type = 'punct'; // keep as punct; walker checks value
      advance(matched.length);
      push(type, matched, s, i, sl, sc);
      continue;
    }

    // single char
    {
      const v = ch;
      let type: TokenType = 'punct';
      if (v === '{') type = 'brace-open';
      else if (v === '}') type = 'brace-close';
      else if (v === '(') type = 'paren-open';
      else if (v === ')') type = 'paren-close';
      else if (v === '[') type = 'bracket-open';
      else if (v === ']') type = 'bracket-close';
      advance(1);
      push(type, v, s, i, sl, sc);
      continue;
    }
  }

  return tokens;
}

/** Significant tokens: everything the walker sees (comments are already dropped). */
export function isCodeToken(_t: Token): boolean {
  return true;
}
