/**
 * @ai-factory/mutation — text-level mutation operators.
 *
 * The source is first segmented into code vs non-code (strings, template
 * literals, comments). Operators only fire inside code segments, so a `+`
 * inside `'a+b'` or `// a + b` is never mutated.
 *
 * Honest boundaries (documented, not hidden):
 *  - Template literals are opaque: `${...}` interpolations are NOT mutated
 *    in v1 (text-level; tracking interpolation nesting is out of scope).
 *  - Regex literals are not specially detected; a `+` inside `/a+b/` is a
 *    legitimate semantic mutant (changes what the regex matches).
 *  - `<`/`>` in generic type arguments (e.g. `Array<string>`) can produce
 *    syntax-invalid mutants; those are classified 'invalid' by the
 *    `node --check` gate in the runner and excluded from the score —
 *    the same treatment Stryker gives compile errors.
 */

export interface Segment {
  text: string;
  /** True when this segment is real code (not string/comment). */
  code: boolean;
  /** Global offset of the segment start in the source. */
  offset: number;
}

type State = 'code' | 'lineComment' | 'blockComment' | 'sq' | 'dq' | 'tpl';

/**
 * Split source into code / non-code segments. Template literals (with
 * `${...}` nesting) are treated as one opaque non-code segment.
 */
export function segmentSource(src: string): Segment[] {
  const segs: Segment[] = [];
  let state: State = 'code';
  let start = 0;
  let tplDepth = 0; // `${` nesting depth inside a template literal
  const push = (end: number, code: boolean): void => {
    if (end > start) segs.push({ text: src.slice(start, end), code, offset: start });
    start = end;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          push(i, true);
          state = 'lineComment';
          i += 2;
        } else if (c === '/' && next === '*') {
          push(i, true);
          state = 'blockComment';
          i += 2;
        } else if (c === "'") {
          push(i, true);
          state = 'sq';
          i++;
        } else if (c === '"') {
          push(i, true);
          state = 'dq';
          i++;
        } else if (c === '`') {
          push(i, true);
          state = 'tpl';
          tplDepth = 0;
          i++;
        } else {
          i++;
        }
        break;
      case 'lineComment':
        if (c === '\n') {
          push(i, false);
          state = 'code';
        }
        i++;
        break;
      case 'blockComment':
        if (c === '*' && next === '/') {
          i += 2;
          push(i, false);
          state = 'code';
        } else {
          i++;
        }
        break;
      case 'sq':
      case 'dq': {
        const quote = state === 'sq' ? "'" : '"';
        if (c === '\\') {
          i += 2;
        } else if (c === quote) {
          i++;
          push(i, false);
          state = 'code';
        } else {
          i++;
        }
        break;
      }
      case 'tpl':
        if (c === '\\') {
          i += 2;
        } else if (c === '$' && next === '{') {
          tplDepth++;
          i += 2;
        } else if (c === '}' && tplDepth > 0) {
          tplDepth--;
          i++;
        } else if (c === '`' && tplDepth === 0) {
          i++;
          push(i, false);
          state = 'code';
        } else {
          i++;
        }
        break;
    }
  }
  push(n, state === 'code');
  return segs;
}

/** One operator hit inside a code segment. */
export interface OperatorSite {
  /** Offset relative to the segment text. */
  index: number;
  length: number;
  replacement: string;
  description: string;
}

export interface MutationOperator {
  name: string;
  title: string;
  description: string;
  find(code: string): OperatorSite[];
}

function regexOp(
  name: string,
  title: string,
  description: string,
  re: RegExp,
  replace: (m: RegExpExecArray) => string,
  describe: (m: RegExpExecArray) => string,
): MutationOperator {
  return {
    name,
    title,
    description,
    find(code: string): OperatorSite[] {
      const out: OperatorSite[] = [];
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(code)) !== null) {
        out.push({ index: m.index, length: m[0].length, replacement: replace(m), description: describe(m) });
        if (m[0].length === 0) rx.lastIndex++;
      }
      return out;
    },
  };
}

/**
 * The 7 text-level operators (v1 set). Each is intentionally narrow:
 * high-value, low-noise, and every site is independently applicable.
 */
export const OPERATORS: MutationOperator[] = [
  regexOp(
    'arithmetic-plus',
    'Arithmetic operator: + → -',
    'Binary/unary `+` becomes `-` (excludes `++`, `+=`, exponent `e+`).',
    /(?<![+\-eE])\+(?![+=])/,
    () => '-',
    () => '`+` → `-`',
  ),
  regexOp(
    'arithmetic-minus',
    'Arithmetic operator: - → +',
    'Binary/unary `-` becomes `+` (excludes `--`, `-=`, exponent `e-`).',
    /(?<![+\-eE])-(?![-=])/,
    () => '+',
    () => '`-` → `+`',
  ),
  regexOp(
    'equality',
    'Equality: === → !==',
    'Strict equality becomes strict inequality.',
    /===/,
    () => '!==',
    () => '`===` → `!==`',
  ),
  regexOp(
    'inequality',
    'Inequality: !== → ===',
    'Strict inequality becomes strict equality.',
    /!==/,
    () => '===',
    () => '`!==` → `===`',
  ),
  {
    name: 'relational-boundary',
    title: 'Relational boundary shift',
    description:
      '`<`→`<=`, `>`→`>=`, `<=`→`<`, `>=`→`>` (excludes `=>`, `<<`, `>>`, JSX `</`).',
    find(code: string): OperatorSite[] {
      const out: OperatorSite[] = [];
      const rx = /(<=|>=|<|>)/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(code)) !== null) {
        const tok = m[1];
        const before = m.index > 0 ? code[m.index - 1] : '';
        const after = m.index + tok.length < code.length ? code[m.index + tok.length] : '';
        let replacement: string | null = null;
        if (tok === '<=') replacement = '<';
        else if (tok === '>=') replacement = '>';
        else if (tok === '<') {
          // exclude `<<`, `</` (JSX close), and `<` glued to `=` on the left
          if (after === '<' || after === '/' || before === '=' || before === '<') continue;
          replacement = '<=';
        } else {
          // '>' — exclude `>>`, `=>`, `->`
          if (after === '>' || after === '=' || before === '=' || before === '-' || before === '>') continue;
          replacement = '>=';
        }
        out.push({
          index: m.index,
          length: tok.length,
          replacement,
          description: `\`${tok}\` → \`${replacement}\``,
        });
      }
      return out;
    },
  },
  regexOp(
    'boolean-literal',
    'Boolean literal flip',
    '`true` becomes `false` and vice versa (word boundaries).',
    /\b(true|false)\b/,
    (m) => (m[1] === 'true' ? 'false' : 'true'),
    (m) => `\`${m[1]}\` → \`${m[1] === 'true' ? 'false' : 'true'}\``,
  ),
  regexOp(
    'logical-operator',
    'Logical operator: && ⇄ ||',
    '`&&` becomes `||` and vice versa.',
    /&&|\|\|/,
    (m) => (m[0] === '&&' ? '||' : '&&'),
    (m) => `\`${m[0]}\` → \`${m[0] === '&&' ? '||' : '&&'}\``,
  ),
];

export function operatorByName(name: string): MutationOperator | undefined {
  return OPERATORS.find((o) => o.name === name);
}

function offsetToLineCol(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (src[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

/**
 * Generate every mutant for a source text. Deterministic: segments and
 * operators are processed in fixed order; output sorted by
 * (line, column, operator).
 */
export function generateMutants(
  source: string,
  file: string,
  operators: readonly MutationOperator[] = OPERATORS,
): import('./types').Mutant[] {
  const segs = segmentSource(source);
  const out: import('./types').Mutant[] = [];
  for (const seg of segs) {
    if (!seg.code) continue;
    for (const op of operators) {
      for (const site of op.find(seg.text)) {
        const offset = seg.offset + site.index;
        const { line, column } = offsetToLineCol(source, offset);
        out.push({
          id: `${file}:${line}:${column}:${op.name}`,
          file,
          operator: op.name,
          line,
          column,
          offset,
          length: site.length,
          original: source.slice(offset, offset + site.length),
          replacement: site.replacement,
          description: site.description,
        });
      }
    }
  }
  out.sort((a, b) =>
    a.line !== b.line
      ? a.line - b.line
      : a.column !== b.column
        ? a.column - b.column
        : a.operator < b.operator
          ? -1
          : a.operator > b.operator
            ? 1
            : 0,
  );
  return out;
}

/** Apply one mutant to the source text (pure). */
export function applyMutant(source: string, mutant: { offset: number; length: number; replacement: string }): string {
  return source.slice(0, mutant.offset) + mutant.replacement + source.slice(mutant.offset + mutant.length);
}
