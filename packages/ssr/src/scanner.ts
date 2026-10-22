/**
 * Structural scanner for TypeScript/JavaScript.
 *
 * Design lineage: the heuristic regex pass of @ai-factory/codeindex
 * (zero dependencies, line-oriented), extended for SSR: visibility /
 * static / async modifiers, variable type annotations, parameter lists,
 * and start..end line ranges via string/comment/template-aware brace
 * matching. TS/JS only (.ts/.tsx/.js/.jsx/.mjs/.cjs).
 *
 * Two phases:
 *   1. mask(): char-level scan → Uint8Array, 1 = real code.
 *   2. extractStructNodes(): line regexes over code regions → nodes,
 *      then brace-match each headed node to its endLine.
 */

import type { StructNode, StructNodeKind } from './types.js';

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

export function ssrSupportedExtensions(): string[] {
  return [...SCAN_EXTS];
}

/**
 * Build a code mask: mask[i] === 1 when text[i] is real code
 * (not inside a string, comment, or template-literal raw part).
 * Template `${...}` interpolations ARE code.
 */
export function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  // state stack; top is current. 'tpl' remembers we must return to template.
  const stack: Array<'code' | 'tpl'> = ['code'];
  let i = 0;
  let tplBraceDepth = 0; // valid only when top is 'tpl-expr' (encoded below)
  // We encode template-expression as a separate parallel stack of depths.
  const tplExprDepths: number[] = [];
  let lineComment = false;
  let blockComment = false;
  let sq = false; // '
  let dq = false; // "
  let tpl = false; // ` raw part

  const topIsTplExpr = () => tplExprDepths.length > 0;

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (sq) {
      if (ch === '\\') {
        i += 2;
      } else if (ch === "'") {
        sq = false;
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (dq) {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '"') {
        dq = false;
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (tpl) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        tpl = false;
        i++;
        continue;
      }
      if (ch === '$' && next === '{') {
        tpl = false;
        tplExprDepths.push(0);
        mask[i] = 1;
        mask[i + 1] = 1;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Real code here.
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      sq = true;
      i++;
      continue;
    }
    if (ch === '"') {
      dq = true;
      i++;
      continue;
    }
    if (ch === '`') {
      tpl = true;
      i++;
      continue;
    }
    if (ch === '{' && topIsTplExpr()) {
      tplExprDepths[tplExprDepths.length - 1]++;
    }
    if (ch === '}' && topIsTplExpr()) {
      const d = tplExprDepths[tplExprDepths.length - 1];
      if (d === 0) {
        tplExprDepths.pop();
        tpl = true; // back to template raw part
        mask[i] = 1;
        i++;
        continue;
      }
      tplExprDepths[tplExprDepths.length - 1] = d - 1;
    }
    // Regex literals: heuristic — a '/' that is not a comment and not
    // division. We treat a '/' as regex start only when the previous
    // code char is one of "=(,:![&|?{};". This is best-effort; a missed
    // regex containing braces can shift a range (documented limitation).
    if (ch === '/' && next !== '/' && next !== '*') {
      let j = i - 1;
      while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j--;
      const prev = j >= 0 ? text[j] : '=';
      if ('=(,:![&|?{};'.includes(prev)) {
        // consume regex literal
        i++;
        let inClass = false;
        while (i < text.length) {
          const r = text[i];
          if (r === '\\') {
            i += 2;
            continue;
          }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) {
            i++;
            while (i < text.length && /[a-z]/i.test(text[i])) i++; // flags
            break;
          } else if (r === '\n') break;
          i++;
        }
        continue;
      }
    }
    mask[i] = 1;
    i++;
    void stack;
    void tplBraceDepth;
  }
  return mask;
}

/** Line offsets for index → line conversion. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: number[], idx: number): number {
  // 1-based line number for char index idx.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface ScannedFile {
  text: string;
  lines: string[];
  mask: Uint8Array;
  starts: number[];
}

export function scanFile(text: string): ScannedFile {
  const mask = codeMask(text);
  return { text, lines: text.split('\n'), mask, starts: lineStarts(text) };
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try',
  'finally', 'with', 'typeof', 'instanceof', 'new', 'delete', 'void',
  'in', 'of', 'super', 'this',
]);

const IDENT = '[A-Za-z_$][\\w$]*';

interface RawHit {
  kind: StructNodeKind;
  name: string;
  line: number; // 1-based
  modifiers: string[];
  typeAnnotation?: string;
  isArrowFn?: boolean;
}

function matchMethod(line: string): { name: string; modifiers: string[] } | null {
  //  public static async get foo(   /  private bar(  /  constructor(
  const m = /^(\s*)((?:public|private|protected)\s+)?((?:static|abstract|override|readonly)\s+)*((?:async)\s+)?((?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
  if (!m) return null;
  const name = m[6];
  if (KEYWORDS.has(name)) return null;
  const modifiers: string[] = [];
  if (m[2]) modifiers.push(m[2].trim());
  if (m[3]) {
    for (const w of m[3].trim().split(/\s+/)) if (w) modifiers.push(w);
  }
  if (m[4]) modifiers.push('async');
  if (m[5]) modifiers.push(m[5].trim()); // get/set
  return { name, modifiers };
}

/** Extract parameter names from a (possibly multi-line) signature. */
function extractParams(sc: ScannedFile, defLine: number, nameEndCol: number): string[] {
  // Find the opening paren at/after the name on the definition line(s).
  const maxLine = Math.min(sc.lines.length, defLine + 20);
  let parenIdx = -1;
  let pl = defLine;
  for (; pl <= maxLine; pl++) {
    const line = sc.lines[pl - 1];
    const from = pl === defLine ? nameEndCol : 0;
    const li = line.indexOf('(', from);
    if (li >= 0) {
      // must be code
      const abs = sc.starts[pl - 1] + li;
      if (sc.mask[abs] === 1) {
        parenIdx = abs;
        break;
      }
    }
    // stop if we hit a line that clearly ends the header without parens
    if (/[;{]$/.test(line.trim()) && pl > defLine) break;
  }
  if (parenIdx < 0) return [];
  // Balance parens (mask-aware).
  let depth = 0;
  let end = -1;
  for (let i = parenIdx; i < sc.text.length; i++) {
    if (sc.mask[i] !== 1) continue;
    const c = sc.text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const inner = sc.text.slice(parenIdx + 1, end);
  // Split top-level commas.
  const parts: string[] = [];
  let cur = '';
  let d = 0;
  let inS = false;
  let inD = false;
  for (const ch of inner) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    if (!inS && !inD) {
      if ('([{<'.includes(ch)) d++;
      else if (')]}>'.includes(ch)) d--;
      else if (ch === ',' && d === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const names: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    // strip decorators/annotations: `a: number = 1` → a ; `...rest` → rest
    const mm = /^(?:public|private|protected|readonly)?\s*(\.\.\.)?([A-Za-z_$][\w$]*)/.exec(t);
    if (mm) names.push(mm[2]);
  }
  return names;
}

/** Find the matching close brace for the first code `{` at/after absIdx. */
function matchBrace(sc: ScannedFile, absIdx: number): number {
  let open = -1;
  for (let i = absIdx; i < sc.text.length; i++) {
    if (sc.mask[i] !== 1) continue;
    if (sc.text[i] === '{') {
      open = i;
      break;
    }
    // A `;` or `)` at top before any `{` means no body (e.g. overload sig).
    if (sc.text[i] === ';') return -1;
  }
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < sc.text.length; i++) {
    if (sc.mask[i] !== 1) continue;
    if (sc.text[i] === '{') depth++;
    else if (sc.text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract structural nodes from TS/JS source.
 * `rel` is the root-relative posix path recorded on each node.
 */
export function extractStructNodes(rel: string, text: string): StructNode[] {
  const sc = scanFile(text);
  const out: StructNode[] = [];
  const classRanges: Array<{ start: number; end: number; name: string }> = [];

  // Phase 1: classes/interfaces/enums/types (need ranges first for methods).
  for (let li = 1; li <= sc.lines.length; li++) {
    const line = sc.lines[li - 1];
    if (!line.trim()) continue;
    const abs = sc.starts[li - 1];
    // skip lines with no code at all
    let hasCode = false;
    for (let i = abs; i < abs + line.length && i < sc.mask.length; i++) {
      if (sc.mask[i] === 1 && !/\s/.test(sc.text[i])) {
        hasCode = true;
        break;
      }
    }
    if (!hasCode) continue;
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*')) continue;

    let m: RegExpExecArray | null;
    let kind: StructNodeKind | null = null;
    let name = '';
    const modifiers: string[] = [];
    if ((m = /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      kind = 'class';
      name = m[4];
      if (m[1]) modifiers.push('export');
      if (m[3]) modifiers.push('abstract');
    } else if ((m = /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/.exec(line))) {
      kind = 'interface';
      name = m[2];
      if (m[1]) modifiers.push('export');
    } else if ((m = /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line))) {
      kind = 'type';
      name = m[2];
      if (m[1]) modifiers.push('export');
    } else if ((m = /^\s*(export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      kind = 'enum';
      name = m[3];
      if (m[1]) modifiers.push('export');
    }
    if (kind && name) {
      const closeIdx = matchBrace(sc, abs);
      const endLine = closeIdx >= 0 ? lineOf(sc.starts, closeIdx) : li;
      if (kind === 'class') classRanges.push({ start: li, end: endLine, name });
      out.push({
        kind,
        name,
        file: rel,
        startLine: li,
        endLine,
        modifiers,
        params: [],
        line: li,
        snippet: line.trim().slice(0, 160),
      });
    }
  }

  // Phase 2: functions, methods, variables.
  const inClass = (li: number): string | undefined => {
    for (const c of classRanges) {
      if (li > c.start && li <= c.end) return c.name;
    }
    return undefined;
  };

  for (let li = 1; li <= sc.lines.length; li++) {
    const line = sc.lines[li - 1];
    if (!line.trim()) continue;
    const abs = sc.starts[li - 1];
    let hasCode = false;
    for (let i = abs; i < abs + line.length && i < sc.mask.length; i++) {
      if (sc.mask[i] === 1 && !/\s/.test(sc.text[i])) {
        hasCode = true;
        break;
      }
    }
    if (!hasCode) continue;
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    // Skip lines already recorded as class/interface/enum/type heads.
    if (out.some((n) => n.startLine === li && (n.kind === 'class' || n.kind === 'interface' || n.kind === 'type' || n.kind === 'enum'))) {
      continue;
    }

    let hit: RawHit | null = null;
    let m: RegExpExecArray | null;

    // method (must be inside a class range)
    const clsName = inClass(li);
    if (clsName) {
      const mm = matchMethod(line);
      if (mm) {
        hit = { kind: 'method', name: mm.name, line: li, modifiers: mm.modifiers };
      }
    }
    // function declaration
    if (!hit && (m = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line))) {
      if (!KEYWORDS.has(m[5])) {
        const mods: string[] = [];
        if (m[1]) mods.push('export');
        if (m[3]) mods.push('async');
        if (m[4]) mods.push('generator');
        hit = { kind: 'function', name: m[5], line: li, modifiers: mods };
      }
    }
    // const/let/var (typed or not; arrow RHS → function)
    if (!hit && (m = /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+?))?\s*(=[\s\S]*)?$/.exec(line))) {
      const rhs = (m[5] || '').trim();
      const isArrow = /=>/.test(rhs);
      const kind: StructNodeKind = isArrow ? 'function' : 'variable';
      const mods: string[] = [];
      if (m[1]) mods.push('export');
      if (isArrow && /^\s*async\b/.test(rhs)) mods.push('async');
      hit = {
        kind,
        name: m[3],
        line: li,
        modifiers: mods,
        typeAnnotation: m[4] ? m[4].trim().slice(0, 120) : undefined,
        isArrowFn: isArrow,
      };
    }

    if (!hit) continue;
    const nameEndCol = line.indexOf(hit.name) + hit.name.length;
    const params = hit.kind === 'function' || hit.kind === 'method' ? extractParams(sc, li, nameEndCol) : [];
    let endLine = li;
    if (hit.kind === 'function' || hit.kind === 'method') {
      const closeIdx = matchBrace(sc, abs);
      endLine = closeIdx >= 0 ? lineOf(sc.starts, closeIdx) : li;
    }
    // parent: innermost enclosing node
    let parent: string | undefined;
    if (clsName && hit.kind === 'method') parent = clsName;
    else {
      // enclosing function: latest function/method node containing this line
      for (let k = out.length - 1; k >= 0; k--) {
        const n = out[k];
        if ((n.kind === 'function' || n.kind === 'method') && li > n.startLine && li <= n.endLine) {
          parent = n.name;
          break;
        }
      }
    }
    out.push({
      kind: hit.kind,
      name: hit.name,
      file: rel,
      startLine: li,
      endLine,
      modifiers: hit.modifiers,
      typeAnnotation: hit.typeAnnotation,
      params,
      line: li,
      snippet: line.trim().slice(0, 160),
      parent,
    });
  }

  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}
