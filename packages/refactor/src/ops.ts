/**
 * @ai-factory/refactor — the four deterministic refactoring operations.
 *
 * All operations are pure functions: (source, …) → edits | error.
 * Same inputs → byte-identical edits. Zero model keys.
 *
 * Supported (TS/JS):
 *   - extract-variable : selected expression → `const name = expr;`
 *   - extract-method   : selected whole lines → new function (closure over
 *                        the enclosing scope; no synthesized params)
 *   - inline-variable  : `const x = init;` → replace uses, drop declaration
 *   - rename-symbol    : scope-aware rename incl. shadowed names + imports
 *
 * Honest limits (also surfaced as warnings/errors, never silent):
 *   - extract-variable replaces only occurrences at/after the insertion
 *     point whose identifiers resolve to the same declarations; earlier
 *     occurrences are left alone (TDZ) and reported.
 *   - extract-method refuses selections containing escaping
 *     return/break/continue, and selections that would leak a declaration
 *     used after the selection.
 *   - inline-variable supports single-declarator `const` (and `let`/`var`
 *     without reassignment); multi-declarators and shared lines are refused.
 *   - rename does not touch property accesses (`obj.old`), string literals,
 *     or dynamic references.
 */

import { Token, isValidIdentifier, lineColToOffset, offsetToLineCol, tokenize } from './tokenizer';
import {
  Declaration,
  Reference,
  Scope,
  ScopeAnalysis,
  analyzeScopes,
  identifierTokenAt,
  isAncestorScope,
} from './scope';
import {
  FileEdits,
  OtherFile,
  RefactorOpResult,
  RefactorWarning,
  Selection,
  TextEdit,
  opError,
  opOk,
} from './types';

/** Apply edits to source. Throws on overlap. Edits must not overlap. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.start > e.end || e.start < 0 || e.end > out.length) {
      throw new Error(`refactor: edit out of range [${e.start},${e.end})`);
    }
    if (e.start < floor && e.end > floor) {
      throw new Error('refactor: overlapping edits');
    }
    // zero-length inserts at the same point are fine; track the tightest floor
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = Math.min(floor, e.start);
  }
  return out;
}

function warn(code: string, message: string): RefactorWarning {
  return { code, message };
}

/** Depth of the code *before* token idx. */
function depthBefore(tokens: Token[], idx: number): number {
  return idx > 0 ? tokens[idx - 1].depth : 0;
}
function pdepthBefore(tokens: Token[], idx: number): number {
  return idx > 0 ? tokens[idx - 1].pdepth : 0;
}

function buildOpenMatch(tokens: Token[]): Map<number, number> {
  const closeMatch = new Map<number, number>();
  const st: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const ty = tokens[k].type;
    if (ty === 'paren-open' || ty === 'bracket-open' || ty === 'brace-open') st.push(k);
    else if (ty === 'paren-close' || ty === 'bracket-close' || ty === 'brace-close') {
      const o = st.pop();
      if (o !== undefined) closeMatch.set(o, k);
    }
  }
  const openMatch = new Map<number, number>();
  for (const [o, c] of closeMatch) openMatch.set(c, o);
  return openMatch;
}

function isOpenTok(t: Token): boolean {
  return t.type === 'paren-open' || t.type === 'bracket-open' || t.type === 'brace-open';
}
function isCloseTok(t: Token): boolean {
  return t.type === 'paren-close' || t.type === 'bracket-close' || t.type === 'brace-close';
}

/**
 * Find the statement containing token `idx`: returns [firstTokIdx, lastTokIdx]
 * (inclusive) — the maximal token run at the same nesting level delimited by
 * `;` or a brace boundary. Balanced bracket groups are skipped while
 * scanning, so `foo({a:1}, x)` is one statement.
 */
function enclosingStatement(
  tokens: Token[], idx: number, openMatch: Map<number, number>,
): [number, number] {
  const d0 = depthBefore(tokens, idx);
  const p0 = pdepthBefore(tokens, idx);
  let s = idx;
  {
    let k = idx - 1;
    while (k >= 0) {
      const tk = tokens[k];
      if (isCloseTok(tk)) {
        const o = openMatch.get(k);
        k = o === undefined ? k - 1 : o - 1;
        continue;
      }
      if (tk.value === ';' && tk.depth <= d0 && tk.pdepth <= p0) break;
      if (tk.type === 'brace-open' && tk.depth === d0) break;
      if (tk.type === 'brace-close' && tk.depth < d0) break;
      k--;
    }
    s = k + 1;
  }
  let e = idx;
  {
    let k = idx + 1;
    while (k < tokens.length) {
      const tk = tokens[k];
      if (isOpenTok(tk)) {
        const c = (() => {
          // find matching close via stack scan
          const st: number[] = [k];
          for (let m = k + 1; m < tokens.length; m++) {
            if (isOpenTok(tokens[m])) st.push(m);
            else if (isCloseTok(tokens[m])) {
              st.pop();
              if (st.length === 0) return m;
            }
          }
          return -1;
        })();
        k = c < 0 ? k + 1 : c + 1;
        continue;
      }
      if (tk.value === ';' && tk.depth <= d0 && tk.pdepth <= p0) {
        e = k;
        break;
      }
      if (tk.type === 'brace-close' && tk.depth < d0) {
        e = k - 1;
        break;
      }
      if (tk.type === 'brace-open' && tk.depth === d0) {
        e = k - 1;
        break;
      }
      e = k;
      k++;
    }
  }
  return [s, Math.max(s, e)];
}

function lineIndent(source: string, line: number): string {
  const off = lineColToOffset(source, line, 1);
  const nl = source.indexOf('\n', off);
  const text = source.slice(off, nl < 0 ? source.length : nl);
  const m = /^[\t ]*/.exec(text);
  return m ? m[0] : '';
}

function detectIndentUnit(source: string): string {
  for (const line of source.split('\n')) {
    const m = /^([\t ]+)\S/.exec(line);
    if (m) return m[1];
  }
  return '  ';
}

/** All identifier tokens (with index) inside [start, end). */
function identifiersIn(
  tokens: Token[], start: number, end: number,
): Array<{ idx: number; tok: Token }> {
  const out: Array<{ idx: number; tok: Token }> = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'identifier' && t.start >= start && t.end <= end) out.push({ idx: k, tok: t });
  }
  return out;
}

const SIDE_EFFECT_PUNCTS = new Set(['(', '=>']);

function expressionSideEffects(tokens: Token[], start: number, end: number): boolean {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.start < start || t.end > end) continue;
    if (t.type === 'keyword' && (t.value === 'new' || t.value === 'await' || t.value === 'yield' || t.value === 'delete')) {
      return true;
    }
    if (t.type === 'punct' || t.type === 'paren-open') {
      if (t.type === 'paren-open') {
        // `(` after an identifier/`)`/`]` is a call; after keywords like
        // `if`/`for`/`while`/`catch`/`switch` it is control flow (pure).
        const p = k > 0 ? tokens[k - 1] : null;
        if (p && (p.type === 'identifier' || p.type === 'paren-close' || p.type === 'bracket-close')) {
          return true;
        }
        continue;
      }
      if (SIDE_EFFECT_PUNCTS.has(t.value)) {
        // `=>` and other suspicious puncts
        return true;
      }
      if (t.value === '++' || t.value === '--') return true;
      if (
        t.value === '=' || t.value === '+=' || t.value === '-=' || t.value === '*=' ||
        t.value === '/=' || t.value === '%=' || t.value === '**=' || t.value === '<<=' ||
        t.value === '>>=' || t.value === '>>>='
      ) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// extract-variable
// ---------------------------------------------------------------------------

export function extractVariable(
  source: string,
  file: string,
  sel: Selection,
  name: string,
): RefactorOpResult {
  if (!isValidIdentifier(name)) {
    return opError('bad-name', `not a valid identifier: ${JSON.stringify(name)}`);
  }
  const s0 = Math.max(0, sel.start);
  const e0 = Math.min(source.length, sel.end);
  const exprRaw = source.slice(s0, e0);
  if (exprRaw.trim() === '') return opError('empty-selection', 'selection is empty');
  // trim to token boundaries
  let s = s0;
  while (s < e0 && /\s/.test(source[s])) s++;
  let e = e0;
  while (e > s && /\s/.test(source[e - 1])) e--;
  const exprText = source.slice(s, e);

  const tokens = tokenize(source);
  const openMatch = buildOpenMatch(tokens);
  const analysis = analyzeScopes(source);

  // selection must not cut a token in half
  for (const t of tokens) {
    if ((t.start < s && s < t.end) || (t.start < e && e < t.end)) {
      return opError('partial-token', 'selection cuts a token in half');
    }
  }
  // first token at/after s
  let firstIdx = -1;
  let lastIdx = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].end <= s) continue;
    if (tokens[k].start >= e) break;
    if (firstIdx < 0) firstIdx = k;
    lastIdx = k;
  }
  if (firstIdx < 0) return opError('empty-selection', 'selection holds no code');

  // single-statement check: no `;` at the selection's level inside
  const dSel = depthBefore(tokens, firstIdx);
  const pSel = pdepthBefore(tokens, firstIdx);
  for (let k = firstIdx; k <= lastIdx; k++) {
    const t = tokens[k];
    if (t.value === ';' && t.depth <= dSel && t.pdepth <= pSel) {
      return opError('multi-statement', 'selection spans more than one statement');
    }
  }

  const [stmtS, stmtE] = enclosingStatement(tokens, firstIdx, openMatch);
  const stmtStartOff = tokens[stmtS].start;
  const insertScope = analysis.scopeAt(stmtStartOff);

  // name must not collide with any declaration visible at the insertion
  // point, and the expression must not already use the name.
  const visibleDecls = analysis.declarations.filter(
    (d) => d.scope === insertScope || isAncestorScope(d.scope, insertScope),
  );
  if (visibleDecls.some((d) => d.name === name)) {
    return opError('name-collision', `name ${JSON.stringify(name)} already exists in this scope`);
  }
  for (const { tok } of identifiersIn(tokens, s, e)) {
    if (tok.value === name) {
      return opError('self-reference', `expression already uses ${JSON.stringify(name)}`);
    }
  }

  // candidate occurrences: identical text within the insert scope, at/after insertion
  const warnings: RefactorWarning[] = [];
  const edits: TextEdit[] = [];
  const exprIdents = identifiersIn(tokens, s, e).map(({ tok }) => ({
    rel: tok.start - s,
    name: tok.value,
    decl: analysis.resolveAt(tok.start, tok.value),
  }));
  let searchFrom = 0;
  let replaced = 0;
  let skippedEarlier = 0;
  let skippedShadow = 0;
  for (;;) {
    const at = source.indexOf(exprText, searchFrom);
    if (at < 0 || at + exprText.length > source.length) break;
    searchFrom = at + 1;
    // must be inside the insert scope's extent
    if (at < insertScope.start || at >= insertScope.end) continue;
    // token-boundary check
    let ok = true;
    for (const t of tokens) {
      if ((t.start < at && at < t.end) || (t.start < at + exprText.length && at + exprText.length < t.end)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // binding-identity check for every identifier in the expression
    for (const ei of exprIdents) {
      const candTok = identifierTokenAt(source, at + ei.rel);
      if (!candTok || candTok.name !== ei.name) {
        ok = false;
        break;
      }
      const candDecl = analysis.resolveAt(candTok.start, candTok.name);
      if (candDecl !== ei.decl) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      skippedShadow++;
      continue;
    }
    if (at < stmtStartOff) {
      skippedEarlier++;
      continue;
    }
    edits.push({ start: at, end: at + exprText.length, text: name });
    replaced++;
  }
  if (replaced === 0) {
    return opError('no-occurrence', 'no replaceable occurrence found (unexpected)');
  }
  if (skippedEarlier > 0) {
    warnings.push(warn(
      'earlier-occurrences',
      `${skippedEarlier} earlier occurrence(s) left in place (they precede the extraction point)`,
    ));
  }
  if (skippedShadow > 0) {
    warnings.push(warn(
      'shadowed-occurrences',
      `${skippedShadow} textually identical occurrence(s) skipped: identifiers resolve differently there`,
    ));
  }
  if (expressionSideEffects(tokens, s, e)) {
    warnings.push(warn(
      'side-effects',
      'expression may have side effects; every replaced occurrence now evaluates once at the extraction point',
    ));
  }

  const { line } = offsetToLineCol(source, stmtStartOff);
  const indent = lineIndent(source, line);
  const lineStart = lineColToOffset(source, line, 1);
  edits.push({
    start: lineStart,
    end: lineStart,
    text: `${indent}const ${name} = ${exprText};\n`,
  });

  return opOk([{ file, edits }], warnings);
}

// ---------------------------------------------------------------------------
// extract-method
// ---------------------------------------------------------------------------

export function extractMethod(
  source: string,
  file: string,
  sel: { startLine: number; endLine: number },
  name: string,
): RefactorOpResult {
  if (!isValidIdentifier(name)) {
    return opError('bad-name', `not a valid identifier: ${JSON.stringify(name)}`);
  }
  const lineCount = source.split('\n').length;
  if (sel.startLine < 1 || sel.endLine > lineCount || sel.startLine > sel.endLine) {
    return opError('bad-selection', 'line range out of bounds');
  }
  const selStart = lineColToOffset(source, sel.startLine, 1);
  let selEnd = lineColToOffset(source, sel.endLine + 1, 1);
  if (sel.endLine === lineCount) selEnd = source.length;
  if (source.slice(selStart, selEnd).trim() === '') {
    return opError('empty-selection', 'selection holds no code');
  }

  const tokens = tokenize(source);
  const analysis = analyzeScopes(source);

  let firstIdx = -1;
  let lastIdx = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].end <= selStart) continue;
    if (tokens[k].start >= selEnd) break;
    if (firstIdx < 0) firstIdx = k;
    lastIdx = k;
  }
  if (firstIdx < 0) return opError('empty-selection', 'selection holds no code');

  // whole statements: brace/paren balance must not dip below the entry level
  const d0 = depthBefore(tokens, firstIdx);
  const p0 = pdepthBefore(tokens, firstIdx);
  let minD = d0;
  let minP = p0;
  for (let k = firstIdx; k <= lastIdx; k++) {
    minD = Math.min(minD, tokens[k].depth);
    minP = Math.min(minP, tokens[k].pdepth);
  }
  const dEnd = tokens[lastIdx].depth
    + (tokens[lastIdx].type === 'brace-open' ? 1 : 0)
    - (tokens[lastIdx].type === 'brace-close' ? 1 : 0);
  const pEnd = tokens[lastIdx].pdepth
    + (tokens[lastIdx].type === 'paren-open' || tokens[lastIdx].type === 'bracket-open' ? 1 : 0)
    - (tokens[lastIdx].type === 'paren-close' || tokens[lastIdx].type === 'bracket-close' ? 1 : 0);
  if (minD < d0 || minP < p0 || dEnd !== d0 || pEnd !== p0) {
    return opError('partial-block', 'selection cuts a block or expression in half');
  }

  const selScope = analysis.scopeAt(selStart);

  // control-flow escape check
  for (let k = firstIdx; k <= lastIdx; k++) {
    const t = tokens[k];
    if (t.type !== 'keyword' || (t.value !== 'return' && t.value !== 'break' && t.value !== 'continue')) continue;
    // walk up: a function scope starting inside the selection contains it
    let sc: Scope | null = analysis.scopeAt(t.start);
    let internal = false;
    while (sc) {
      if (sc.kind === 'function' && sc.start >= selStart && sc.start < selEnd) {
        internal = true;
        break;
      }
      if (sc === selScope) break;
      sc = sc.parent;
    }
    if (!internal) {
      return opError('control-flow', `selection contains escaping ${t.value} (not supported)`);
    }
  }

  // name collision in the insertion scope
  if (analysis.resolveAt(selStart, name)) {
    return opError('name-collision', `name ${JSON.stringify(name)} already exists in this scope`);
  }

  // free variables: referenced in selection, declared outside (or unresolved).
  // The extracted function is inserted in the SAME scope, so it closes over
  // outer bindings — no parameters are synthesized. Only *assigned* outer
  // variables need a return path.
  const assigned = new Map<string, Reference>(); // name -> one write ref
  let hasAwait = false;
  let hasThis = false;
  for (const r of analysis.references) {
    if (r.start < selStart || r.start >= selEnd) continue;
    // skip references inside nested functions defined in the selection
    let sc: Scope | null = r.scope;
    let nested = false;
    while (sc && sc !== selScope) {
      if (sc.kind === 'function' && sc.start >= selStart) {
        nested = true;
        break;
      }
      sc = sc.parent;
    }
    if (nested) continue;
    const d = r.decl;
    if (!d) {
      // unresolved global — visible from the extracted function too; no action
      continue;
    }
    const declaredInside = d.identStart >= selStart && d.identStart < selEnd;
    if (!declaredInside) {
      if (r.isWrite && (d.kind === 'const' || d.kind === 'let' || d.kind === 'var' || d.kind === 'param' || d.kind === 'catch')) {
        if (d.kind === 'const') {
          return opError('const-reassign', `selection assigns to const ${JSON.stringify(r.name)} declared outside`);
        }
        if (!assigned.has(r.name)) assigned.set(r.name, r);
      }
    }
  }
  for (let k = firstIdx; k <= lastIdx; k++) {
    const t = tokens[k];
    if (t.type === 'keyword' && t.value === 'await') {
      const sc = analysis.scopeAt(t.start);
      let s2: Scope | null = sc;
      let nestedFn = false;
      while (s2 && s2 !== selScope) {
        if (s2.kind === 'function' && s2.start >= selStart) {
          nestedFn = true;
          break;
        }
        s2 = s2.parent;
      }
      if (!nestedFn) hasAwait = true;
    }
    if ((t.type === 'keyword' && (t.value === 'this' || t.value === 'super')) || t.value === 'arguments') {
      const sc = analysis.scopeAt(t.start);
      let s2: Scope | null = sc;
      let nestedFn = false;
      while (s2 && s2 !== selScope) {
        if (s2.kind === 'function' && s2.start >= selStart) {
          nestedFn = true;
          break;
        }
        s2 = s2.parent;
      }
      if (!nestedFn) hasThis = true;
    }
  }

  // declarations inside the selection must not be used after it
  for (const d of analysis.declarations) {
    if (d.identStart < selStart || d.identStart >= selEnd) continue;
    if (d.kind === 'import') continue;
    for (const r of analysis.refsOf(d)) {
      if (r.start >= selEnd) {
        return opError('leak', `declaration ${JSON.stringify(d.name)} is used after the selection`);
      }
    }
  }

  const warnings: RefactorWarning[] = [];
  if (hasThis) {
    warnings.push(warn('this-context', 'selection uses this/arguments/super; the extracted function will not share the dynamic context'));
  }

  const { line: firstLine } = offsetToLineCol(source, selStart);
  const baseIndent = lineIndent(source, firstLine);
  const unit = detectIndentUnit(source);
  const fnIndent = baseIndent;

  // re-indent selection lines one level deeper
  const selText = source.slice(selStart, selEnd);
  const selLines = selText.split('\n');
  // drop trailing empty line produced by selEnd landing at a line start
  if (selLines.length > 0 && selLines[selLines.length - 1].trim() === '') selLines.pop();
  const minIndent = selLines
    .filter((l) => l.trim() !== '')
    .reduce((m, l) => {
      const mm = /^[\t ]*/.exec(l);
      const ind = mm ? mm[0] : '';
      return ind.length < m.length ? ind : m;
    }, selLines.find((l) => l.trim() !== '') ?? '');
  const bodyLines = selLines.map((l) => {
    if (l.trim() === '') return '';
    const stripped = l.startsWith(minIndent) ? l.slice(minIndent.length) : l.trimStart();
    return unit + stripped;
  });

  const assignedNames = [...assigned.keys()];
  let returnStmt = '';
  let callAssign = '';
  if (assignedNames.length === 1) {
    returnStmt = `${unit}return ${assignedNames[0]};`;
    callAssign = `${assignedNames[0]} = `;
  } else if (assignedNames.length > 1) {
    returnStmt = `${unit}return { ${assignedNames.join(', ')} };`;
    callAssign = `({ ${assignedNames.join(', ')} } = `;
  }
  const asyncKw = hasAwait ? 'async ' : '';
  const awaitKw = hasAwait ? 'await ' : '';
  const fnText =
    `${fnIndent}${asyncKw}function ${name}() {\n` +
    bodyLines.join('\n') +
    (returnStmt ? `\n${returnStmt}` : '') +
    `\n${fnIndent}}\n`;
  const callText =
    assignedNames.length > 1
      ? `${fnIndent}${callAssign}${awaitKw}${name}());\n`
      : `${fnIndent}${callAssign}${awaitKw}${name}();\n`;

  const edits: TextEdit[] = [{ start: selStart, end: selEnd, text: fnText + callText }];
  return opOk([{ file, edits }], warnings);
}

// ---------------------------------------------------------------------------
// inline-variable
// ---------------------------------------------------------------------------

export function inlineVariable(source: string, file: string, offset: number): RefactorOpResult {
  const ident = identifierTokenAt(source, offset);
  if (!ident) return opError('no-identifier', 'no identifier at the given offset');
  const analysis = analyzeScopes(source);
  const decl = analysis.resolveAt(ident.start, ident.name);
  if (!decl) return opError('unresolved', `cannot resolve ${JSON.stringify(ident.name)}`);
  if (decl.kind !== 'const' && decl.kind !== 'let' && decl.kind !== 'var') {
    return opError('not-a-variable', `${JSON.stringify(ident.name)} is not a variable`);
  }
  if (decl.initStart < 0) {
    return opError('no-init', `${JSON.stringify(ident.name)} has no initializer`);
  }
  // single declarator on a standalone line: the statement must not continue
  // with `, <more declarators>`
  const afterDecl = source.slice(decl.declEnd).match(/^\s*/)?.[0] ?? '';
  const nextCh = source[decl.declEnd + afterDecl.length];
  if (nextCh === ',') {
    return opError('multi-declarator', 'only single-declarator statements can be inlined');
  }
  const stmtText = source.slice(decl.declStart, decl.declEnd);
  if (topLevelCommas(stmtText)) {
    return opError('multi-declarator', 'only single-declarator statements can be inlined');
  }
  const { line: declLine } = offsetToLineCol(source, decl.declStart);
  const lineStart = lineColToOffset(source, declLine, 1);
  const lineEndIdx = source.indexOf('\n', lineStart);
  const lineEnd = lineEndIdx < 0 ? source.length : lineEndIdx;
  const lineText = source.slice(lineStart, lineEnd);
  const beforeDecl = lineText.slice(0, decl.declStart - lineStart);
  const semiIdx = lineText.indexOf(';', decl.declEnd - lineStart);
  if (semiIdx < 0) return opError('not-alone', 'declaration statement has no terminator on this line');
  const afterSemi = lineText.slice(semiIdx + 1);
  if (beforeDecl.trim() !== '' || afterSemi.trim() !== '') {
    return opError('not-alone', 'declaration shares its line with other code');
  }

  const refs = analysis.refsOf(decl);
  for (const r of refs) {
    if (r.isWrite) {
      return opError('reassigned', `${JSON.stringify(ident.name)} is reassigned; cannot inline`);
    }
    if (r.start < decl.identStart) {
      return opError('use-before-decl', `${JSON.stringify(ident.name)} is used before its declaration`);
    }
  }

  const initText = source.slice(decl.initStart, decl.initEnd);
  const parens = initNeedsParens(initText);
  const replacement = parens ? `(${initText})` : initText;
  const warnings: RefactorWarning[] = [];
  if (parens) {
    warnings.push(warn('parenthesized', 'initializer was wrapped in parentheses to preserve precedence'));
  }
  if (refs.length === 0) {
    warnings.push(warn('unused', `${JSON.stringify(ident.name)} has no uses; the declaration is simply removed`));
  }

  const edits: TextEdit[] = [];
  for (const r of refs) {
    edits.push({ start: r.start, end: r.end, text: replacement });
  }
  // remove the whole line including the newline
  const removeEnd = lineEndIdx < 0 ? source.length : lineEndIdx + 1;
  edits.push({ start: lineStart, end: removeEnd, text: '' });
  return opOk([{ file, edits }], warnings);
}

/** True when `text` contains a top-level comma (multi-declarator). */
function topLevelCommas(text: string): boolean {
  const toks = tokenize(text);
  for (const t of toks) {
    if (t.value === ',' && t.depth === 0 && t.pdepth === 0) return true;
  }
  return false;
}

/** Conservative: parenthesize unless the init is trivially atomic. */
function initNeedsParens(initText: string): boolean {
  const toks = tokenize(initText);
  if (toks.length === 0) return true;
  const first = toks[0];
  // object literal / function / class / arrow need parens in most positions
  if (first.type === 'brace-open') return true;
  if (first.type === 'keyword' && (first.value === 'function' || first.value === 'class')) return true;
  let depth = 0;
  let pdepth = 0;
  for (const t of toks) {
    if (t.type === 'punct' && depth === 0 && pdepth === 0) {
      if (
        t.value === '=>' || t.value === '?' || t.value === ':' || t.value === ',' ||
        t.value === '=' || t.value === '==' || t.value === '===' ||
        t.value === '!=' || t.value === '!==' || t.value === '+' ||
        t.value === '-' || t.value === '*' || t.value === '/' ||
        t.value === '%' || t.value === '**' || t.value === '<' ||
        t.value === '>' || t.value === '<=' || t.value === '>=' ||
        t.value === '&&' || t.value === '||' || t.value === '??' ||
        t.value === '&' || t.value === '|' || t.value === '^' ||
        t.value === '<<' || t.value === '>>' || t.value === '>>>' ||
        t.value === 'in' || t.value === 'instanceof'
      ) {
        return true;
      }
    }
    if (t.type === 'keyword' && depth === 0 && pdepth === 0 &&
      (t.value === 'await' || t.value === 'yield' || t.value === 'typeof' ||
        t.value === 'void' || t.value === 'delete' || t.value === 'new')) {
      return true;
    }
    if (t.type === 'paren-open' || t.type === 'bracket-open' || t.type === 'brace-open') {
      if (t.type === 'paren-open') pdepth++;
      else depth++;
    }
    if (t.type === 'paren-close' || t.type === 'bracket-close' || t.type === 'brace-close') {
      if (t.type === 'paren-close') pdepth--;
      else depth--;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// rename-symbol (single file + cross-file import updates)
// ---------------------------------------------------------------------------

export interface RenamePlan {
  file: string;
  edits: TextEdit[];
  warnings: RefactorWarning[];
}

/**
 * Rename the symbol at `offset` to `newName` in `source`.
 * `otherFiles` are additional files to update when they import the renamed
 * export from `file` (the caller resolves which files import from where).
 */
export function renameSymbol(
  source: string,
  file: string,
  offset: number,
  newName: string,
  otherFiles: OtherFile[] = [],
): RefactorOpResult {
  if (!isValidIdentifier(newName)) {
    return opError('bad-name', `not a valid identifier: ${JSON.stringify(newName)}`);
  }
  const ident = identifierTokenAt(source, offset);
  if (!ident) return opError('no-identifier', 'no identifier at the given offset');
  const oldName = ident.name;
  if (oldName === newName) return opError('same-name', 'new name is identical to the old name');
  if (oldName.startsWith('#')) {
    return opError('private-field', 'private fields are not supported');
  }

  const analysis = analyzeScopes(source);
  const decl = analysis.resolveAt(ident.start, oldName);

  // gather the rename set: declaration ident + bound references
  const targets: Array<{ start: number; end: number }> = [];
  if (decl) {
    targets.push({ start: decl.identStart, end: decl.identEnd });
  }
  const refs = analysis.references.filter(
    (r) => r.name === oldName && r.decl === decl,
  );
  for (const r of refs) targets.push({ start: r.start, end: r.end });
  if (targets.length === 0) {
    return opError('no-targets', `no occurrences of ${JSON.stringify(oldName)} found`);
  }

  // collision check per affected scope
  const warnings: RefactorWarning[] = [];
  const scopesToCheck = new Set<Scope>();
  if (decl) scopesToCheck.add(decl.scope);
  for (const r of refs) scopesToCheck.add(r.scope);
  for (const sc of scopesToCheck) {
    let s: Scope | null = sc;
    while (s) {
      const arr = s.declarations.get(newName);
      const clash = arr && arr.some((d) => d !== decl);
      if (clash) {
        return opError('name-collision', `${JSON.stringify(newName)} already exists in this scope`);
      }
      s = s.parent;
    }
  }

  const fileEdits: FileEdits[] = [];
  const mainEdits: TextEdit[] = targets.map((t) => ({ start: t.start, end: t.end, text: newName }));
  fileEdits.push({ file, edits: mainEdits });

  // cross-file: update importers of this export
  if (decl && (decl.kind === 'function' || decl.kind === 'class' || decl.kind === 'const' ||
    decl.kind === 'let' || decl.kind === 'var' || decl.kind === 'method')) {
    for (const other of otherFiles) {
      const upd = updateImporter(other.source, other.path, oldName, newName);
      if (upd.edits.length > 0) {
        fileEdits.push({ file: other.path, edits: upd.edits });
        warnings.push(...upd.warnings);
      }
    }
  }

  return opOk(fileEdits, warnings);
}

/**
 * In an importing file, update `import { oldName }` / `import { oldName as x }`
 * to the new exported name. Local references follow the local binding.
 */
function updateImporter(
  source: string, file: string, oldExported: string, newExported: string,
): { edits: TextEdit[]; warnings: RefactorWarning[] } {
  const edits: TextEdit[] = [];
  const warnings: RefactorWarning[] = [];
  const analysis = analyzeScopes(source);
  for (const d of analysis.declarations) {
    if (d.kind !== 'import' || d.importedName !== oldExported) continue;
    // rewrite the specifier: `oldName` -> `newExported [as local]`
    const tokens = tokenize(source);
    let specTok: Token | null = null;
    for (const t of tokens) {
      if (t.type === 'identifier' && t.start >= d.declStart && t.start < d.identStart && t.value === oldExported) {
        specTok = t;
        break;
      }
    }
    if (!specTok) {
      // `import { oldName }` — the local name IS the specifier
      specTok = { type: 'identifier', value: oldExported, start: d.identStart, end: d.identEnd, line: 1, col: 1, depth: 0, pdepth: 0 };
    }
    if (d.name === oldExported) {
      // `import { oldName }` → `import { newExported }` + rename local refs
      edits.push({ start: specTok.start, end: specTok.end, text: newExported });
      for (const r of analysis.refsOf(d)) {
        edits.push({ start: r.start, end: r.end, text: newExported });
      }
    } else {
      // `import { oldName as alias }` → `import { newExported as alias }`; refs keep `alias`
      edits.push({ start: specTok.start, end: specTok.end, text: newExported });
      warnings.push(warn('import-alias', `${file}: import alias ${JSON.stringify(d.name)} kept; specifier updated`));
    }
  }
  return { edits, warnings };
}
