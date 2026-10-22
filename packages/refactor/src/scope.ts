/**
 * @ai-factory/refactor — scope analysis for TS/JS.
 *
 * Two passes over the token stream:
 *   1. Build the scope tree + declarations. Lexical declarations
 *      (`const`/`let`/`var`) are parsed eagerly at the keyword: binding
 *      names (incl. destructuring + TS type annotations) are declared
 *      immediately, while the main walk still visits every token so
 *      nested scopes inside initializers are built normally.
 *   2. Resolve every identifier reference to its declaration by walking
 *      outward from the innermost containing scope.
 *
 * Heuristic but honest: `with`, labels, `eval`, dynamic property access,
 * computed member writes and class fields are documented limits, not
 * silent lies. Name-based (not type-based): same as the repomap philosophy.
 */

import { Token, tokenize } from './tokenizer';

export type ScopeKind = 'program' | 'function' | 'block' | 'class' | 'for' | 'catch';
export type DeclKind =
  | 'const' | 'let' | 'var' | 'function' | 'class'
  | 'param' | 'import' | 'catch' | 'method';

export interface Scope {
  id: number;
  kind: ScopeKind;
  parent: Scope | null;
  children: Scope[];
  declarations: Map<string, Declaration[]>;
  /** 0-based offsets of the scope's extent. */
  start: number;
  end: number;
  /** Index of the `{` token that opens this scope (-1 when merged/none). */
  braceIdx: number;
}

export interface Declaration {
  name: string;
  kind: DeclKind;
  scope: Scope;
  /** Identifier token offsets. */
  identStart: number;
  identEnd: number;
  /** Initializer offsets (-1 when none). */
  initStart: number;
  initEnd: number;
  /** Whole declaration statement offsets (for inline removal). */
  declStart: number;
  declEnd: number;
  /** For imports: module specifier + originally imported name. */
  importedFrom?: string;
  importedName?: string;
}

export interface Reference {
  name: string;
  start: number;
  end: number;
  scope: Scope;
  decl: Declaration | null;
  /** True when this reference assigns to the name (x=, x++, ++x …). */
  isWrite: boolean;
}

export interface ScopeAnalysis {
  root: Scope;
  scopes: Scope[];
  declarations: Declaration[];
  references: Reference[];
  /** Resolve `name` as seen from `offset` (innermost scope first). */
  resolveAt: (offset: number, name: string) => Declaration | null;
  /** All references bound to this declaration (identity). */
  refsOf: (decl: Declaration) => Reference[];
  /** Innermost scope containing offset. */
  scopeAt: (offset: number) => Scope;
}

/** Globals that never become extract-method params. */
const BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Intl', 'Reflect', 'Proxy', 'BigInt', 'globalThis', 'window',
  'document', 'process', 'require', 'module', 'exports', '__dirname',
  '__filename', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'crypto', 'Buffer', 'performance', 'queueMicrotask',
  'structuredClone', 'navigator', 'localStorage', 'sessionStorage',
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'arguments', 'undefined', 'NaN', 'Infinity',
]);

export function isBuiltin(name: string): boolean {
  return BUILTINS.has(name);
}

const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=',
  '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
]);

interface PendingFunc {
  kwIdx: number;
  /** Declared name token index (-1 for anonymous). */
  nameTok: number;
  kind: DeclKind;
  declScope: Scope;
  declStart: number;
  /** For method shorthand: parameter token indices (declared at body `{`). */
  paramIdx?: number[];
}

/** True when `cand` is a strict ancestor of `scope` in the scope tree. */
export function isAncestorScope(cand: Scope, scope: Scope): boolean {
  let p: Scope | null = scope.parent;
  while (p) {
    if (p === cand) return true;
    p = p.parent;
  }
  return false;
}

export function analyzeScopes(source: string): ScopeAnalysis {
  const tokens = tokenize(source);
  const n = tokens.length;

  let scopeId = 0;
  const scopes: Scope[] = [];
  const declarations: Declaration[] = [];

  function newScope(kind: ScopeKind, parent: Scope | null, start: number): Scope {
    const s: Scope = {
      id: scopeId++, kind, parent, children: [],
      declarations: new Map(), start, end: source.length, braceIdx: -1,
    };
    if (parent) parent.children.push(s);
    scopes.push(s);
    return s;
  }

  const root = newScope('program', null, 0);
  const stack: Scope[] = [root];

  // bracket matching for (), [], {} (template ${ pairs as braces)
  const closeMatch = new Map<number, number>();
  {
    const st: number[] = [];
    for (let k = 0; k < n; k++) {
      const ty = tokens[k].type;
      if (ty === 'paren-open' || ty === 'bracket-open' || ty === 'brace-open') st.push(k);
      else if (ty === 'paren-close' || ty === 'bracket-close' || ty === 'brace-close') {
        const o = st.pop();
        if (o !== undefined) closeMatch.set(o, k);
      }
    }
  }

  const closeToOpen = new Map<number, number>();
  for (const [o, c] of closeMatch) closeToOpen.set(c, o);

  const prevSig = (idx: number): number => (idx > 0 ? idx - 1 : -1);
  const nextSig = (idx: number): number => (idx + 1 < n ? idx + 1 : -1);

  function declare(
    name: string, kind: DeclKind, scope: Scope, tokIdx: number,
    declStart: number,
    extra?: { importedFrom?: string; importedName?: string },
  ): Declaration {
    const t = tokens[tokIdx];
    const d: Declaration = {
      name, kind, scope,
      identStart: t.start, identEnd: t.end,
      initStart: -1, initEnd: -1, declStart, declEnd: t.end,
      ...extra,
    };
    const arr = scope.declarations.get(name);
    if (arr) arr.push(d);
    else scope.declarations.set(name, [d]);
    declarations.push(d);
    return d;
  }

  // token indices consumed as declarations / non-references
  const declTokIdx = new Set<number>();
  const nonRefIdx = new Set<number>();
  function markDecl(ti: number): void {
    declTokIdx.add(ti);
    nonRefIdx.add(ti);
  }

  /**
   * Collect binding identifiers from a destructuring pattern or parameter
   * list. `i` = first token inside the pattern; `stopTokIdx` = the closing
   * bracket's token index. Handles nesting, defaults (`a = expr` — the
   * default expression's identifiers are NOT bindings), rest elements and
   * TS type annotations (`a: T` — `a` is the binding, `T` is skipped).
   */
  function collectPatternNames(
    i: number,
    stopTokIdx: number,
    openType: 'brace-open' | 'bracket-open' | 'paren-open' | '' = '',
  ): { names: number[]; end: number } {
    const names: number[] = [];
    let k = i;
    let depth = 0;
    // bracket-type stack: distinguishes object-pattern keys (`{a: 1}` — `a`
    // is a key) from typed params (`(a: T)` — `a` is a binding).
    const bstack: string[] = openType ? [openType] : [];
    let inDefault = false;
    let ternary = 0;
    const stopAt = (idx: number): boolean => idx === stopTokIdx || idx >= n;
    while (k < n && !stopAt(k)) {
      const t = tokens[k];
      if (t.type === 'brace-open' || t.type === 'paren-open' || t.type === 'bracket-open') {
        depth++;
        bstack.push(t.type);
        k = nextSig(k);
        continue;
      }
      if (t.type === 'brace-close' || t.type === 'paren-close' || t.type === 'bracket-close') {
        if (depth === 0) break;
        depth--;
        bstack.pop();
        k = nextSig(k);
        continue;
      }
      if (depth === 0) {
        if (t.value === '=') {
          inDefault = true;
          k = nextSig(k);
          continue;
        }
        if (t.value === ',') {
          inDefault = false;
          k = nextSig(k);
          continue;
        }
        if (t.type === 'punct' && t.value === '?') {
          ternary++;
          k = nextSig(k);
          continue;
        }
        if (t.type === 'punct' && t.value === ':') {
          if (ternary > 0) ternary--;
          k = nextSig(k);
          continue;
        }
      }
      if (t.type === 'identifier' && !inDefault && t.value !== 'arguments') {
        const nx = nextSig(k);
        const nxv = nx >= 0 ? tokens[nx].value : '';
        if (nxv === ':' && ternary === 0) {
          const pv = prevSig(k) >= 0 ? tokens[prevSig(k)].value : '';
          const inner = bstack.length > 0 ? bstack[bstack.length - 1] : '';
          // object-pattern key (`{a: 1}`, `{a: b}`): the key is not a binding.
          // In paren patterns (`(a: T)`) the name IS the binding.
          if (inner === 'brace-open' && (pv === '{' || pv === ',')) {
            k = nextSig(k); // skip the key; the value scans normally
            continue;
          }
          // `name: Type` — name is the binding; skip the type annotation
          names.push(k);
          let m = nextSig(nx);
          let d2 = 0;
          while (m >= 0 && m < n && !stopAt(m)) {
            const tt = tokens[m];
            if (tt.type === 'brace-open' || tt.type === 'paren-open' || tt.type === 'bracket-open') d2++;
            else if (tt.type === 'brace-close' || tt.type === 'paren-close' || tt.type === 'bracket-close') {
              if (d2 === 0) break;
              d2--;
            } else if (d2 === 0 && (tt.value === ',' || tt.value === '=')) break;
            m = nextSig(m);
          }
          k = m;
          continue;
        }
        names.push(k);
      }
      k = nextSig(k);
    }
    return { names, end: k };
  }

  function declareNames(names: number[], kind: DeclKind, scope: Scope, declStart: number): Declaration[] {
    const out: Declaration[] = [];
    for (const ti of names) {
      out.push(declare(tokens[ti].value, kind, scope, ti, declStart));
      markDecl(ti);
    }
    return out;
  }

  /**
   * Eagerly parse `const`/`let`/`var` declarators starting at the keyword
   * token `kwIdx`. Declares every binding into `scope` immediately and
   * records init/decl extents. Returns the token index right after the
   * keyword so the main walk still visits every token (nested scopes
   * inside initializers are built normally); binding identifiers are
   * marked and skipped as references.
   */
  function parseDeclarators(kwIdx: number, kind: 'const' | 'let' | 'var', scope: Scope): number {
    const kw = tokens[kwIdx];
    const depth0 = kw.depth;
    const pdepth0 = kw.pdepth;
    const declStart = kw.start;
    let j = nextSig(kwIdx);
    const atBase = (idx: number): boolean =>
      idx >= 0 && tokens[idx].depth === depth0 && tokens[idx].pdepth === pdepth0;
    const isDedent = (idx: number): boolean => {
      if (idx < 0) return true;
      const tt = tokens[idx];
      return (tt.type === 'brace-close' && tt.depth < depth0) ||
        (tt.type === 'paren-close' && tt.pdepth < pdepth0);
    };
    while (j >= 0 && j < n) {
      // one binding pattern
      const tj = tokens[j];
      const names: number[] = [];
      if (tj.type === 'brace-open' || tj.type === 'bracket-open') {
        const close = closeMatch.get(j);
        if (close === undefined) break;
        const inner = collectPatternNames(nextSig(j), close, tj.type);
        names.push(...inner.names);
        j = nextSig(close);
      } else if (tj.type === 'identifier') {
        names.push(j);
        j = nextSig(j);
      } else {
        break; // malformed — bail out, main walk continues
      }
      const curDecls = declareNames(names, kind, scope, declStart);
      // optional TS type annotation `: T`
      if (j >= 0 && tokens[j].value === ':' && atBase(j)) {
        j = nextSig(j);
        while (j >= 0 && j < n && !isDedent(j)) {
          const tt = tokens[j];
          if (atBase(j) && (tt.value === '=' || tt.value === ',' || tt.value === ';' ||
            (tt.type === 'keyword' && (tt.value === 'in' || tt.value === 'of')))) break;
          j = nextSig(j);
        }
      }
      // optional initializer
      let initStart = -1;
      let initEnd = -1;
      if (j >= 0 && tokens[j].value === '=' && atBase(j)) {
        const ie = nextSig(j);
        initStart = ie >= 0 ? tokens[ie].start : -1;
        j = ie;
        while (j >= 0 && j < n && !isDedent(j)) {
          const tt = tokens[j];
          if (atBase(j) && (tt.value === ',' || tt.value === ';' ||
            (tt.type === 'keyword' && (tt.value === 'in' || tt.value === 'of')))) break;
          j = nextSig(j);
        }
        initEnd = j >= 0 ? tokens[j].start : source.length;
      }
      const declEnd = j >= 0 ? tokens[j].start : source.length;
      for (const d of curDecls) {
        d.initStart = initStart;
        d.initEnd = initEnd;
        d.declEnd = declEnd;
      }
      if (j >= 0 && tokens[j].value === ',' && atBase(j)) {
        j = nextSig(j);
        continue;
      }
      break;
    }
    // Do NOT skip the init: the main walk must visit every token so nested
    // scopes (arrows, function expressions) inside initializers are built.
    return nextSig(kwIdx);
  }

  let pendingFunc: PendingFunc | null = null;
  let pendingClass = false;
  let pendingArrowBody = false;
  let arrowExprEndIdx = -1;
  let pendingHeaderScope: Scope | null = null;
  const exportRefIdx: number[] = [];

  let i = 0;
  while (i < n) {
    if (i < 0) break; // nextSig() hit the end
    const t = tokens[i];
    const cur = stack[stack.length - 1];

    // expression-bodied arrow: pop the scope pushed at `=>`
    if (arrowExprEndIdx >= 0 && i >= arrowExprEndIdx) {
      const top = stack[stack.length - 1];
      if (top.kind === 'function' && top !== root) {
        top.end = t.start;
        stack.pop();
      }
      arrowExprEndIdx = -1;
    }

    if (t.type === 'keyword') {
      const v = t.value;
      if (v === 'function') {
        let k = nextSig(i);
        if (k >= 0 && tokens[k].value === '*') k = nextSig(k);
        let nameTok = -1;
        if (k >= 0 && tokens[k].type === 'identifier') {
          const kk = nextSig(k);
          if (kk >= 0 && tokens[kk].type === 'paren-open') {
            nameTok = k;
            declare(tokens[k].value, 'function', cur, k, t.start);
            markDecl(k);
          }
        }
        pendingFunc = { kwIdx: i, nameTok, kind: 'function', declScope: cur, declStart: t.start };
        i = nextSig(i);
        continue;
      }
      if (v === 'class') {
        const k = nextSig(i);
        if (k >= 0 && tokens[k].type === 'identifier') {
          const kk = nextSig(k);
          if (kk >= 0 && (tokens[kk].type === 'brace-open' || tokens[kk].value === 'extends' || tokens[kk].value === 'implements')) {
            declare(tokens[k].value, 'class', cur, k, t.start);
            markDecl(k);
          }
        }
        pendingClass = true;
        i = nextSig(i);
        continue;
      }
      if (v === 'const' || v === 'let' || v === 'var') {
        i = parseDeclarators(i, v, cur);
        continue;
      }
      if (v === 'import') {
        const nx = nextSig(i);
        if (nx >= 0 && tokens[nx].type === 'paren-open') {
          i = nextSig(i); // dynamic import() — ordinary call
          continue;
        }
        let k = nx;
        const imported: Array<{ ti: number; importedName: string }> = [];
        if (k >= 0 && tokens[k].type === 'identifier') {
          imported.push({ ti: k, importedName: 'default' });
          k = nextSig(k);
          if (k >= 0 && tokens[k].value === ',') k = nextSig(k);
        }
        if (k >= 0 && tokens[k].value === '*') {
          const ka = nextSig(k);
          if (ka >= 0 && tokens[ka].value === 'as') {
            const kb = nextSig(ka);
            if (kb >= 0 && tokens[kb].type === 'identifier') {
              imported.push({ ti: kb, importedName: '*' });
              markDecl(ka);
              k = nextSig(kb);
            }
          }
        } else if (k >= 0 && tokens[k].type === 'brace-open') {
          const close = closeMatch.get(k);
          let m = nextSig(k);
          while (m >= 0 && (close === undefined || m < close)) {
            const mt = tokens[m];
            if (mt.type === 'identifier') {
              const m2 = nextSig(m);
              if (m2 >= 0 && tokens[m2].value === 'as') {
                const m3 = nextSig(m2);
                if (m3 >= 0 && tokens[m3].type === 'identifier') {
                  imported.push({ ti: m3, importedName: mt.value });
                  markDecl(m);
                  markDecl(m2);
                  markDecl(m3);
                  m = nextSig(m3);
                  continue;
                }
              }
              imported.push({ ti: m, importedName: mt.value });
              markDecl(m);
            }
            m = nextSig(m);
          }
          if (close !== undefined) k = nextSig(close);
        }
        // module specifier: last string token before `;`
        let spec = '';
        {
          let s = k;
          while (s >= 0 && s < n && tokens[s].value !== ';' && tokens[s].type !== 'brace-close') {
            if (tokens[s].type === 'string') spec = tokens[s].value.slice(1, -1);
            s = nextSig(s);
          }
        }
        for (const im of imported) {
          declare(tokens[im.ti].value, 'import', cur, im.ti, t.start,
            { importedFrom: spec, importedName: im.importedName });
          markDecl(im.ti);
        }
        i = k >= 0 ? k : n;
        continue;
      }
      if (v === 'export') {
        const nx = nextSig(i);
        if (nx >= 0 && tokens[nx].type === 'brace-open') {
          const close = closeMatch.get(nx);
          let m = nextSig(nx);
          while (m >= 0 && (close === undefined || m < close)) {
            const mt = tokens[m];
            if (mt.type === 'identifier') {
              const m2 = nextSig(m);
              if (m2 >= 0 && tokens[m2].value === 'as') {
                exportRefIdx.push(m);
                markDecl(m2);
                const m3 = nextSig(m2);
                if (m3 >= 0) {
                  nonRefIdx.add(m3); // exported name — not a local reference
                  m = nextSig(m3);
                  continue;
                }
              } else {
                exportRefIdx.push(m);
              }
            }
            m = nextSig(m);
          }
          i = close !== undefined ? nextSig(close) : n;
          continue;
        }
        i = nextSig(i);
        continue;
      }
      if (v === 'for' || v === 'catch') {
        let nx = nextSig(i);
        if (nx >= 0 && tokens[nx].value === 'await') {
          const nn = nextSig(nx);
          if (nn >= 0 && tokens[nn].type === 'paren-open') nx = nn;
        }
        if (nx >= 0 && tokens[nx].type === 'paren-open') {
          const hdr = newScope(v === 'for' ? 'for' : 'catch', cur, t.start);
          stack.push(hdr);
          pendingHeaderScope = hdr;
          if (v === 'catch') {
            const close = closeMatch.get(nx);
            if (close !== undefined && close > nx) {
              const inner = collectPatternNames(nextSig(nx), close, 'paren-open');
              declareNames(inner.names, 'catch', hdr, t.start);
            }
          }
        }
        i = nextSig(i);
        continue;
      }
      i = nextSig(i);
      continue;
    }

    if (t.type === 'identifier' && !declTokIdx.has(i)) {
      // method shorthand: `name(...) {`, `get name() {`, `async name() {`
      const nx = nextSig(i);
      if (nx >= 0 && tokens[nx].type === 'paren-open') {
        const pv = prevSig(i) >= 0 ? tokens[prevSig(i)].value : '';
        const ppv = prevSig(i) > 0 ? tokens[prevSig(prevSig(i))].value : '';
        const methodish =
          pv === '' || pv === '{' || pv === ',' || pv === ';' || pv === '}' || pv === ':' ||
          ((pv === 'get' || pv === 'set' || pv === 'async' || pv === '*') &&
            (ppv === '' || ppv === '{' || ppv === ',' || ppv === ';' || ppv === '}'));
        const close = closeMatch.get(nx);
        const after = close !== undefined ? nextSig(close) : -1;
        if (methodish && close !== undefined && after >= 0 && tokens[after].type === 'brace-open') {
          declare(t.value, 'method', cur, i, t.start);
          markDecl(i);
          const inner = collectPatternNames(nextSig(nx), close, 'paren-open');
          pendingFunc = {
            kwIdx: i, nameTok: i, kind: 'method',
            declScope: cur, declStart: t.start, paramIdx: inner.names,
          };
          i = nextSig(i);
          continue;
        }
      }
      i = nextSig(i);
      continue;
    }

    if (t.type === 'punct' && t.value === '=>') {
      const p = prevSig(i);
      const fnScope = newScope('function', cur, t.start);
      let paramNames: number[] = [];
      if (p >= 0 && tokens[p].type === 'paren-close') {
        let open = -1;
        for (const [o, c] of closeMatch) {
          if (c === p) {
            open = o;
            break;
          }
        }
        if (open >= 0) {
          paramNames = collectPatternNames(nextSig(open), p, 'paren-open').names;
        }
      } else if (p >= 0 && tokens[p].type === 'identifier' && !declTokIdx.has(p)) {
        paramNames = [p];
      }
      declareNames(paramNames, 'param', fnScope, t.start);
      stack.push(fnScope);
      pendingArrowBody = true;
      const nn = nextSig(i);
      if (nn < 0 || tokens[nn].type !== 'brace-open') {
        // expression body: precompute its end
        const baseDepth = t.depth;
        const baseP = t.pdepth;
        let k = nn;
        while (k >= 0 && k < n) {
          const kt = tokens[k];
          if (kt.depth < baseDepth) break;
          if (kt.depth === baseDepth) {
            if (kt.value === ';') break;
            if (kt.value === ',' && kt.pdepth <= baseP) break;
            if ((kt.type === 'paren-close' || kt.type === 'bracket-close') && kt.pdepth < baseP) break;
            if (kt.type === 'brace-close' && kt.pdepth <= baseP) break;
          }
          k = nextSig(k);
        }
        arrowExprEndIdx = k;
      } else {
        arrowExprEndIdx = -1;
      }
      i = nextSig(i);
      continue;
    }

    if (t.type === 'brace-open') {
      if (pendingFunc) {
        const fnScope = newScope('function', cur, t.start);
        if (pendingFunc.paramIdx) {
          declareNames(pendingFunc.paramIdx, 'param', fnScope, pendingFunc.declStart);
        } else {
          // `function` keyword form: find `(` after the name (or keyword)
          const from = pendingFunc.nameTok >= 0 ? pendingFunc.nameTok : pendingFunc.kwIdx;
          const k = nextSig(from);
          if (k >= 0 && tokens[k].type === 'paren-open') {
            const close = closeMatch.get(k);
            if (close !== undefined) {
              const inner = collectPatternNames(nextSig(k), close, 'paren-open');
              declareNames(inner.names, 'param', fnScope, pendingFunc.declStart);
            }
          }
        }
        fnScope.braceIdx = i;
        stack.push(fnScope);
        pendingFunc = null;
        i = nextSig(i);
        continue;
      }
      if (pendingArrowBody) {
        const top = stack[stack.length - 1];
        top.braceIdx = i; // body brace merges into the arrow scope
        pendingArrowBody = false;
        i = nextSig(i);
        continue;
      }
      if (pendingHeaderScope) {
        pendingHeaderScope.braceIdx = i; // for/catch body merges
        pendingHeaderScope = null;
        i = nextSig(i);
        continue;
      }
      if (pendingClass) {
        const cs = newScope('class', cur, t.start);
        cs.braceIdx = i;
        stack.push(cs);
        pendingClass = false;
        i = nextSig(i);
        continue;
      }
      const bs = newScope('block', cur, t.start);
      bs.braceIdx = i;
      stack.push(bs);
      i = nextSig(i);
      continue;
    }

    if (t.type === 'brace-close') {
      const top = stack[stack.length - 1];
      // only pop when this `}` matches the scope's `{`
      const openOfClose = closeToOpen.get(i) ?? -1;
      if (top !== root && top.braceIdx === openOfClose) {
        top.end = t.end;
        stack.pop();
      }
      // single-statement for/catch body ends at `;`
      i = nextSig(i);
      continue;
    }

    if (t.value === ';' && pendingHeaderScope) {
      const top = stack[stack.length - 1];
      if (top === pendingHeaderScope) {
        top.end = t.end;
        stack.pop();
      }
      pendingHeaderScope = null;
      i = nextSig(i);
      continue;
    }

    i = nextSig(i);
  }

  for (const s of stack) s.end = source.length;

  // ---- pass 2: references ----
  const references: Reference[] = [];

  function innermostScope(offset: number): Scope {
    let best: Scope = root;
    const visit = (s: Scope): void => {
      // children are in source order; pick the deepest containing child
      for (const c of s.children) {
        if (offset >= c.start && offset < c.end) {
          best = c;
          visit(c);
          return;
        }
      }
    };
    visit(root);
    return best;
  }

  function resolveIn(name: string, scope: Scope): Declaration | null {
    let s: Scope | null = scope;
    while (s) {
      const arr = s.declarations.get(name);
      if (arr && arr.length > 0) return arr[arr.length - 1];
      s = s.parent;
    }
    return null;
  }

  for (let k = 0; k < n; k++) {
    const t = tokens[k];
    if (t.type !== 'identifier') continue;
    if (declTokIdx.has(k) || nonRefIdx.has(k)) continue;
    // property access: `obj.name`, `obj?.name` — not a variable reference
    const pv = prevSig(k) >= 0 ? tokens[prevSig(k)].value : '';
    if (pv === '.' || pv === '?.') continue;
    // object key / label: `name:` where the name opens an object member.
    // (ternary `a ? b : c` is excluded: `b`'s prev is `?`, not `{`/`,`)
    const nx = nextSig(k);
    if (nx >= 0 && tokens[nx].value === ':') {
      if (pv === '{' || pv === ',') continue;
    }
    const scope = innermostScope(t.start);
    const decl = resolveIn(t.value, scope);
    const nxv = nx >= 0 ? tokens[nx].value : '';
    const isWrite =
      ASSIGN_OPS.has(nxv) || nxv === '++' || nxv === '--' ||
      pv === '++' || pv === '--';
    references.push({ name: t.value, start: t.start, end: t.end, scope, decl, isWrite });
  }
  for (const ek of exportRefIdx) {
    const t = tokens[ek];
    const scope = innermostScope(t.start);
    references.push({
      name: t.value, start: t.start, end: t.end,
      scope, decl: resolveIn(t.value, scope), isWrite: false,
    });
  }

  return {
    root,
    scopes,
    declarations,
    references,
    resolveAt: (offset: number, name: string) => {
      for (let k = 0; k < n; k++) {
        const t = tokens[k];
        if (t.type === 'identifier' && offset >= t.start && offset < t.end && !declTokIdx.has(k)) {
          return resolveIn(t.value, innermostScope(t.start));
        }
      }
      for (const d of declarations) {
        if (d.name === name && offset >= d.identStart && offset < d.identEnd) return d;
      }
      return null;
    },
    refsOf: (decl: Declaration) => references.filter((r) => r.decl === decl),
    scopeAt: innermostScope,
  };
}

/** Identifier token covering `offset`, or null. */
export function identifierTokenAt(
  source: string, offset: number,
): { start: number; end: number; name: string } | null {
  for (const t of tokenize(source)) {
    if (t.type === 'identifier' && offset >= t.start && offset < t.end) {
      return { start: t.start, end: t.end, name: t.value };
    }
  }
  return null;
}
