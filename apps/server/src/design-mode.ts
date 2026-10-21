/**
 * Design mode — deterministic core (v0 Design Mode style, no real-model dependency).
 *
 * Element → source locate + class-token / literal-text write-back as pure,
 * deterministic string transforms. No filesystem, no DOM, no network —
 * the HTTP routes in ./routes/design.ts own the fs access, the RBAC and
 * the shadow-checkpoint undo.
 *
 * Honest boundaries (also surfaced in the UI copy):
 * - The locate is HEURISTIC: tag + class-token overlap + literal text.
 *   Dynamically rendered content ({expr} in JSX, API data, .map() lists)
 *   cannot be text-matched; repeated elements match the first in
 *   document order — we never pretend to know which instance was clicked.
 * - Write-back only swaps Tailwind class-name TOKENS and literal text
 *   content. No .css edits, no layout drag-and-drop, no semantic refactor.
 * - Non-Tailwind projects: only locate + text edit are offered; the style
 *   controls are disabled with an explicit reason.
 */
export interface ElementFingerprint {
  /** Lower-case tag name as seen in the DOM, e.g. 'div', 'button'. */
  tag: string;
  /** class tokens on the element (from the DOM class attribute). */
  classes: string[];
  /** Trimmed textContent of the element, truncated by the picker (≤120). */
  text: string;
}

export interface LocatedElement {
  /** 1-based line number of the opening tag. */
  line: number;
  /** 1-based column number of the '<' of the opening tag. */
  column: number;
  /** Literal text content between the tags (null for self-closing / dynamic / empty). */
  text: string | null;
  /** Class tokens on the opening tag's class/className attribute. */
  classes: string[];
}

/** One Tailwind edit dimension. bg-color/text-color/text-size/padding/margin. */
export type StyleFamily = 'bg-color' | 'text-color' | 'text-size' | 'padding' | 'margin';

export interface StyleEdits {
  /** New literal text content (operator-typed). */
  text?: string;
  /** A bg-* class token. */
  bgColor?: string;
  /** A text-* color class token (not a size token). */
  textColor?: string;
  /** A text-* size class token (text-xs … text-9xl). */
  fontSize?: string;
  /** A p-* class token. */
  padding?: string;
  /** An m-* class token. */
  margin?: string;
}

const TEXT_SIZES = new Set([
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
]);

/**
 * Which style family a Tailwind token belongs to. Variant-prefixed tokens
 * (hover:bg-…, md:text-…) are deliberately family-null: we never rewrite
 * stateful variants — the UI only offers unprefixed tokens and this is
 * the enforcement point.
 */
export function classTokenFamily(token: string): StyleFamily | null {
  if (token.includes(':')) return null;
  if (token.startsWith('bg-')) return 'bg-color';
  if (token.startsWith('text-')) {
    const rest = token.slice('text-'.length);
    return TEXT_SIZES.has(rest) ? 'text-size' : 'text-color';
  }
  if (/^p-\d/.test(token) || token.startsWith('p-[')) return 'padding';
  if (/^m-\d/.test(token) || token.startsWith('m-[')) return 'margin';
  return null;
}

interface ScannedElement {
  tag: string;
  /** Offset of '<'. */
  start: number;
  /** Offset just past the '>' that closes the opening tag. */
  openEnd: number;
  line: number;
  column: number;
  classValue: string | null;
  /** Offsets of the class value inside the attribute (valueStart..valueEnd). */
  classSpan: { start: number; end: number } | null;
  /** Whether the class attribute was className (JSX) or class (HTML). */
  classIsJsx: boolean;
  /** Offset span of the literal text node after the opening tag (trimmed later). */
  textSpan: { start: number; end: number } | null;
  selfClosing: boolean;
}

function isTagChar(ch: string): boolean {
  return /[A-Za-z0-9._-]/.test(ch);
}

/**
 * Scan every opening tag in the source. Quote-aware so '>' inside
 * attribute values does not end the tag early. Text span = the raw text
 * between the end of the opening tag and the next '<' (not parsed into a
 * tree on purpose — the heuristic boundary is documented above).
 */
export function scanElements(source: string): ScannedElement[] {
  const els: ScannedElement[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    // Advance line bookkeeping to lt.
    for (let k = i; k < lt; k++) {
      if (source[k] === '\n') {
        line += 1;
        lineStart = k + 1;
      }
    }
    i = lt + 1;
    if (i >= n) break;
    const next = source[i];
    // Skip comments, doctypes, closing tags, PIs.
    if (next === '!' || next === '?' || next === '/') continue;
    // Parse tag name.
    let j = i;
    while (j < n && isTagChar(source[j])) j++;
    if (j === i) continue;
    const tag = source.slice(i, j).toLowerCase();
    // Scan to the closing '>' (quote-aware).
    let quote: string | null = null;
    let openEnd = -1;
    let k = j;
    for (; k < n; k++) {
      const ch = source[k];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        openEnd = k + 1;
        break;
      }
    }
    if (openEnd === -1) break; // unterminated — stop scanning honestly
    const openTag = source.slice(lt, openEnd);
    const selfClosing = /\/\s*>$/.test(openTag);
    // class / className attribute (double-quoted, single-quoted, or {'...'}).
    let classValue: string | null = null;
    let classSpan: { start: number; end: number } | null = null;
    let classIsJsx = false;
    const attrRe = /\b(className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)')\s*\})/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(openTag)) !== null) {
      classIsJsx = m[1] === 'className';
      classValue = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
      // m[2..5] positions are relative to openTag; map the matched value group back.
      const groupIndex = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : m[4] !== undefined ? 4 : 5;
      const groupStartInTag = openTag.indexOf(m[groupIndex] as string, m.index);
      classSpan = { start: lt + groupStartInTag, end: lt + groupStartInTag + (m[groupIndex] as string).length };
      break; // first class attribute wins (an element has exactly one)
    }
    // Text span: up to the next '<'.
    let textSpan: { start: number; end: number } | null = null;
    if (!selfClosing) {
      const nextLt = source.indexOf('<', openEnd);
      const textEnd = nextLt === -1 ? n : nextLt;
      if (textEnd > openEnd) textSpan = { start: openEnd, end: textEnd };
    }
    els.push({
      tag,
      start: lt,
      openEnd,
      line,
      column: lt - lineStart + 1,
      classValue,
      classSpan,
      classIsJsx,
      textSpan,
      selfClosing,
    });
    // Continue scanning from openEnd so nested elements are found too.
    for (let k2 = lt; k2 < openEnd; k2++) {
      if (source[k2] === '\n') {
        line += 1;
        lineStart = k2 + 1;
      }
    }
    i = openEnd;
  }
  return els;
}

function literalTextOf(el: ScannedElement, source: string): string | null {
  if (!el.textSpan) return null;
  const raw = source.slice(el.textSpan.start, el.textSpan.end);
  if (raw.includes('{')) return null; // dynamic (JSX expression) — never text-matched
  const t = raw.trim();
  return t ? t : null;
}

/**
 * Heuristic locate: score each same-tag element by
 *   classOverlap (matched fp tokens / fp tokens) + 2 * textMatch.
 * When the fingerprint carries text and the candidate has literal text,
 * the text MUST match — this keeps two same-class siblings with
 * different labels from cross-matching. Repeated identical elements
 * (e.g. .map() lists) resolve to the first in document order — an
 * explicit honest boundary, not a bug.
 */
export function locateElement(source: string, fp: ElementFingerprint): LocatedElement | null {
  const els = scanElements(source);
  let best: LocatedElement | null = null;
  let bestScore = -1;
  for (const el of els) {
    if (el.tag !== fp.tag.toLowerCase()) continue;
    const tokens = (el.classValue ?? '').split(/\s+/).filter(Boolean);
    let classScore = 0;
    if (fp.classes.length > 0) {
      const set = new Set(tokens);
      const matched = fp.classes.filter((c) => set.has(c)).length;
      classScore = matched / fp.classes.length;
    }
    const text = literalTextOf(el, source);
    let textScore = 0;
    if (fp.text && text) {
      textScore = text.includes(fp.text) || fp.text.includes(text) ? 1 : 0;
      if (textScore === 0) continue; // literal mismatch — never cross-match
    }
    const score = classScore + 2 * textScore;
    const viable =
      (fp.classes.length > 0 && classScore > 0) ||
      (fp.text && textScore > 0) ||
      (fp.classes.length === 0 && !fp.text && true);
    if (!viable || score <= bestScore) continue;
    bestScore = score;
    best = { line: el.line, column: el.column, text, classes: tokens };
  }
  return best;
}

/**
 * Replace class tokens of one family with a single new token, or append
 * when the family is absent. Returns the edited source, or null when the
 * element has no class attribute and jsxHint cannot decide which
 * attribute name to insert (caller must supply it).
 */
export function applyClassTokenEdit(
  source: string,
  located: LocatedElement,
  family: StyleFamily,
  newToken: string,
  jsxHint?: boolean,
): string | null {
  // Re-scan to get exact offsets for this line (scan is deterministic),
  // then pick the tag on that line closest to the located column.
  const els = scanElements(source);
  const target = els
    .filter((e) => e.line === located.line)
    .sort((a, b) => Math.abs(a.column - located.column) - Math.abs(b.column - located.column))[0];
  if (!target) return null;
  const tokens = (target.classValue ?? '').split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => classTokenFamily(t) !== family);
  const nextTokens = [...kept, newToken];
  if (target.classSpan) {
    return (
      source.slice(0, target.classSpan.start) +
      nextTokens.join(' ') +
      source.slice(target.classSpan.end)
    );
  }
  // No class attribute — insert one. JSX hint comes from the scan; the
  // explicit argument overrides for callers that know better.
  const jsx = jsxHint ?? target.classIsJsx;
  const attr = jsx ? 'className' : 'class';
  const insertAt = target.openEnd - (target.selfClosing ? 2 : 1);
  const value = nextTokens.join(' ');
  return source.slice(0, insertAt) + ` ${attr}="${value}"` + source.slice(insertAt);
}

/**
 * Replace the element's literal text. Refuses (null) when the current
 * literal text no longer equals `expected` — the drift guard: the caller
 * must re-locate rather than overwrite something the operator did not pick.
 */
export function applyTextEdit(
  source: string,
  located: LocatedElement,
  expected: string,
  newText: string,
): string | null {
  const els = scanElements(source);
  const target = els
    .filter((e) => e.line === located.line)
    .sort((a, b) => Math.abs(a.column - located.column) - Math.abs(b.column - located.column))[0];
  if (!target || !target.textSpan) return null;
  const raw = source.slice(target.textSpan.start, target.textSpan.end);
  if (raw.trim() !== expected) return null;
  const leading = raw.slice(0, raw.length - raw.trimStart().length);
  const trailing = raw.slice(raw.trimEnd().length);
  return (
    source.slice(0, target.textSpan.start) + leading + newText + trailing + source.slice(target.textSpan.end)
  );
}

/**
 * Apply a full edit batch. Each step re-locates by (file, line) so that
 * offset shifts from earlier steps do not corrupt later ones. Returns the
 * final source, or null on any failure (first failing step's reason).
 */
export function applyStyleEdits(
  source: string,
  fp: ElementFingerprint,
  line: number,
  edits: StyleEdits,
  jsx: boolean,
): { content: string; applied: string[] } | { error: string } {
  let current = source;
  const applied: string[] = [];
  const tokenEdits: Array<{ family: StyleFamily; token: string; key: string }> = [];
  if (edits.bgColor !== undefined) tokenEdits.push({ family: 'bg-color', token: edits.bgColor, key: 'bgColor' });
  if (edits.textColor !== undefined)
    tokenEdits.push({ family: 'text-color', token: edits.textColor, key: 'textColor' });
  if (edits.fontSize !== undefined)
    tokenEdits.push({ family: 'text-size', token: edits.fontSize, key: 'fontSize' });
  if (edits.padding !== undefined) tokenEdits.push({ family: 'padding', token: edits.padding, key: 'padding' });
  if (edits.margin !== undefined) tokenEdits.push({ family: 'margin', token: edits.margin, key: 'margin' });
  for (const te of tokenEdits) {
    const located = locateElement(current, fp);
    if (!located || located.line !== line) {
      return { error: `drift: element no longer at line ${line} while applying ${te.key}` };
    }
    const next = applyClassTokenEdit(current, located, te.family, te.token, jsx);
    if (next === null) return { error: `cannot apply ${te.key}: element not found at line ${line}` };
    current = next;
    applied.push(te.key);
  }
  if (edits.text !== undefined) {
    const located = locateElement(current, fp);
    if (!located || located.line !== line) {
      return { error: `drift: element no longer at line ${line} while applying text` };
    }
    if (located.text === null) return { error: 'text edit refused: element has no literal text' };
    const next = applyTextEdit(current, located, located.text, edits.text);
    if (next === null) return { error: 'text edit refused: content changed since locate (drift)' };
    current = next;
    applied.push('text');
  }
  return { content: current, applied };
}

/**
 * Pure Tailwind signal detection. The route supplies: the workspace
 * package.json text (or null), root file names matching tailwind.config.*,
 * and small CSS samples. All heuristics, all disclosed in `reason`.
 */
export function detectTailwind(input: {
  packageJson: string | null;
  configFiles: string[];
  cssSamples: string[];
}): { tailwind: boolean; reason: string } {
  if (input.packageJson) {
    try {
      const pj = JSON.parse(input.packageJson) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) };
      if (Object.keys(deps).some((d) => d === 'tailwindcss')) {
        return { tailwind: true, reason: 'tailwindcss listed in package.json' };
      }
    } catch {
      // unparseable package.json is not a tailwind signal — keep looking
    }
  }
  if (input.configFiles.length > 0) {
    return { tailwind: true, reason: `found ${input.configFiles[0]}` };
  }
  if (
    input.cssSamples.some(
      (css) => css.includes('@tailwind') || css.includes('@import "tailwindcss"') || css.includes("@import 'tailwindcss'"),
    )
  ) {
    return { tailwind: true, reason: 'tailwind directives found in CSS' };
  }
  return { tailwind: false, reason: 'no tailwindcss dependency, config, or CSS directives found' };
}
