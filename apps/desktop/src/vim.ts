/**
 * Vim key layer for the desktop editor (round-6 R6-B9). React-free and
 * Monaco-free so node:test can import it directly (same reason as
 * keybinding/manager.ts). The Monaco adapter lives in adapter.ts; this
 * module owns only the state machine over plain lines.
 *
 * Design: every keystroke returns the edits it causes plus the resulting
 * cursor/mode/selection. The adapter applies the edits to Monaco (so
 * Monaco's own undo stack stays intact) and renders the mode. State
 * lines are always updated by applying the returned edits, so the two
 * can never drift apart.
 *
 * v1 SUPPORT TABLE (documented, not a full Vim):
 *   modes: normal / insert / visual (char) / visual-line / command-line
 *   motions: h j k l, w W b B e E, 0 ^ $, gg G, f F t T + char, %
 *   operators: d c y (+ linewise dd cc yy), counts (e.g. 3dw, d2w)
 *   edits: x X r p P i a A I o O J D C Y, u (undo via adapter), Ctrl+R redo
 *   visual: v V, motions, d x y c, o (swap anchor), Esc
 *   command-line: :w only (save via adapter)
 *   NOT in v1: macros, named registers, search (/ ? n N), . repeat, marks,
 *   text objects (ciw/daw), visual-block (Ctrl+V), :q and other Ex commands,
 *   folds, jump list, :s. Unknown keys are swallowed in normal mode (Vim
 *   beeps; we stay silent) so they never leak into the buffer.
 *
 * Interaction with the round-5 keybinding system (defined, not accidental):
 * Vim-prefix-first. While Vim mode is on and the editor is focused,
 * unmodified keystrokes are consumed by the Vim layer first and never
 * reach the global which-key sequences (the global manager already
 * ignores unmodified keys in editable targets). Modified chords
 * (Ctrl/Cmd/Alt) still go to the global registry: Ctrl+S saves, Ctrl+K
 * opens the palette, and the user can bind vim.toggle there.
 */

export type VimMode = 'normal' | 'insert' | 'visual' | 'visualLine';

export interface VimPos {
  line: number;
  col: number;
}

/** Replace [start, end) with text (text may contain newlines). */
export interface VimEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface VimKeyInput {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}

export interface VimKeyResult {
  handled: boolean;
  edits: VimEdit[];
  cursor: VimPos;
  /** Visual selection (anchor, head) when in a visual mode, else null. */
  selection: { anchor: VimPos; head: VimPos } | null;
  mode: VimMode;
  /** Command-line echo (e.g. ':w') while typing an Ex command, else null. */
  commandLine: string | null;
  /** One-shot status message (e.g. unknown Ex command), else null. */
  message: string | null;
  /** Adapter-side action: 'undo' | 'redo' | 'save' | null. */
  action: 'undo' | 'redo' | 'save' | null;
}

export interface VimState {
  lines: string[];
  cursor: VimPos;
  mode: VimMode;
  /** Pending numeric prefix, '' when none. */
  count: string;
  operator: '' | 'd' | 'c' | 'y';
  /** Pending f/F/t/T awaiting its target character. */
  pendingFind: '' | 'f' | 'F' | 't' | 'T';
  /** 'g' pressed, awaiting the second key (gg). */
  pendingG: boolean;
  /** Pending r awaiting its replacement character. */
  pendingReplace: boolean;
  anchor: VimPos | null;
  register: { text: string; linewise: boolean };
  /** Accumulated Ex input including the leading ':', '' when inactive. */
  commandLine: string;
}

export function createVimState(text: string): VimState {
  return {
    lines: text.split('\n'),
    cursor: { line: 0, col: 0 },
    mode: 'normal',
    count: '',
    operator: '',
    pendingFind: '',
    pendingG: false,
    pendingReplace: false,
    anchor: null,
    register: { text: '', linewise: false },
    commandLine: '',
  };
}

/** Apply one edit to a lines array (pure helper, also used by tests). */
export function applyEditToLines(lines: string[], edit: VimEdit): string[] {
  const before = lines.slice(0, edit.startLine);
  const after = lines.slice(edit.endLine + 1);
  const first = lines[edit.startLine] ?? '';
  const last = lines[edit.endLine] ?? '';
  const middle = first.slice(0, edit.startCol) + edit.text + last.slice(edit.endCol);
  return [...before, ...middle.split('\n'), ...after];
}

export function applyEditsToLines(lines: string[], edits: VimEdit[]): string[] {
  let out = lines;
  for (const e of edits) out = applyEditToLines(out, e);
  return out;
}

function lineLen(lines: string[], line: number): number {
  return (lines[line] ?? '').length;
}

function clampNormal(lines: string[], pos: VimPos): VimPos {
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  const maxCol = Math.max(0, lineLen(lines, line) - 1);
  return { line, col: Math.max(0, Math.min(pos.col, maxCol)) };
}

function clampInsert(lines: string[], pos: VimPos): VimPos {
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  return { line, col: Math.max(0, Math.min(pos.col, lineLen(lines, line))) };
}

function firstNonBlank(lines: string[], line: number): number {
  const text = lines[line] ?? '';
  const m = /[^ \t]/.exec(text);
  return m ? m.index : 0;
}

function countOf(state: VimState): number {
  return state.count === '' ? 1 : parseInt(state.count, 10);
}

function clearPending(state: VimState): void {
  state.count = '';
  state.operator = '';
  state.pendingFind = '';
  state.pendingG = false;
  state.pendingReplace = false;
}

/* ------------------------------------------------------------------ */
/* Character stream over lines: newline counts as a space for word     */
/* motions, so w/b/e cross lines the way Vim does.                     */
/* ------------------------------------------------------------------ */

type CharClass = 'space' | 'word' | 'punct';

function classOf(ch: string | null): CharClass {
  if (ch === null || ch === ' ' || ch === '\t' || ch === '\n') return 'space';
  if (/[A-Za-z0-9_]/.test(ch) || ch.charCodeAt(0) > 127) return 'word';
  return 'punct';
}

/** Character at pos, or null at end of document. Newline reads as '\n'. */
function charAt(lines: string[], pos: VimPos): string | null {
  if (pos.line >= lines.length) return null;
  const text = lines[pos.line];
  if (pos.col < text.length) return text[pos.col];
  if (pos.col === text.length && pos.line < lines.length - 1) return '\n';
  return null;
}

function advance(lines: string[], pos: VimPos): VimPos | null {
  if (pos.line >= lines.length) return null;
  const text = lines[pos.line];
  if (pos.col < text.length) return { line: pos.line, col: pos.col + 1 };
  if (pos.line < lines.length - 1) return { line: pos.line + 1, col: 0 };
  return null;
}

function retreat(lines: string[], pos: VimPos): VimPos | null {
  if (pos.col > 0) return { line: pos.line, col: pos.col - 1 };
  if (pos.line > 0) return { line: pos.line - 1, col: lineLen(lines, pos.line - 1) };
  return null;
}

function nextWordStart(lines: string[], from: VimPos, bigWord: boolean): VimPos | null {
  let p: VimPos | null = from;
  const cls = classOf(charAt(lines, p));
  if (cls !== 'space') {
    // Skip the rest of the current run.
    while (p !== null) {
      const c = classOf(charAt(lines, p));
      if (bigWord ? c === 'space' : c !== cls) break;
      p = advance(lines, p);
    }
  }
  while (p !== null && classOf(charAt(lines, p)) === 'space') p = advance(lines, p);
  if (p === null) return null;
  // p may sit on a newline's virtual position (col == len); normalize to
  // the first char of the next line, which the loop above already yields
  // as (nextLine, 0) — but a trailing-newline landing needs care:
  if (p.col > lineLen(lines, p.line)) return null;
  return p;
}

function prevWordStart(lines: string[], from: VimPos, bigWord: boolean): VimPos {
  let p: VimPos | null = retreat(lines, from);
  if (p === null) return { line: 0, col: 0 };
  while (p !== null && classOf(charAt(lines, p)) === 'space') p = retreat(lines, p);
  if (p === null) return { line: 0, col: 0 };
  const cls = classOf(charAt(lines, p));
  while (p !== null) {
    const prev = retreat(lines, p);
    if (prev === null) break;
    const c = classOf(charAt(lines, prev));
    if (bigWord ? c === 'space' : c !== cls) break;
    p = prev;
  }
  return p ?? { line: 0, col: 0 };
}

function nextWordEnd(lines: string[], from: VimPos, bigWord: boolean): VimPos | null {
  let p: VimPos | null = advance(lines, from);
  if (p === null) return null;
  while (p !== null && classOf(charAt(lines, p)) === 'space') p = advance(lines, p);
  if (p === null) return null;
  const cls = classOf(charAt(lines, p));
  let last: VimPos = p;
  while (p !== null) {
    const c = classOf(charAt(lines, p));
    if (bigWord ? c === 'space' : c !== cls) break;
    last = p;
    p = advance(lines, p);
  }
  return last;
}

const BRACKET_PAIRS: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
};
const OPEN_BRACKETS = new Set(['(', '[', '{']);

function matchBracket(lines: string[], from: VimPos): VimPos | null {
  let start: VimPos | null = from;
  const first = charAt(lines, from);
  if (first === null || !(first in BRACKET_PAIRS)) {
    // Find the next bracket on the same line.
    const text = lines[from.line] ?? '';
    let found = -1;
    for (let i = from.col; i < text.length; i++) {
      if (text[i] in BRACKET_PAIRS) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    start = { line: from.line, col: found };
  }
  const startChar = charAt(lines, start) as string;
  const forward = OPEN_BRACKETS.has(startChar);
  // The matching bracket is always the pair of the start char; nesting
  // counts further occurrences of the start char itself.
  const match = BRACKET_PAIRS[startChar];
  let depth = 0;
  let p: VimPos | null = start;
  const step = forward ? advance : retreat;
  while (p !== null) {
    p = step(lines, p);
    if (p === null) break;
    const ch = charAt(lines, p);
    if (ch === null) break;
    if (ch === startChar) depth++;
    else if (ch === match) {
      if (depth === 0) return p;
      depth--;
    }
  }
  return null;
}

function findCharOnLine(
  lines: string[],
  from: VimPos,
  ch: string,
  forward: boolean,
  before: boolean,
): VimPos | null {
  const text = lines[from.line] ?? '';
  if (forward) {
    const idx = text.indexOf(ch, from.col + 1);
    if (idx === -1) return null;
    return { line: from.line, col: before ? idx - 1 : idx };
  }
  const idx = text.lastIndexOf(ch, from.col - 1);
  if (idx === -1) return null;
  return { line: from.line, col: before ? idx + 1 : idx };
}

interface MotionResult {
  to: VimPos;
  /** True for linewise motions (gg/G/dd-style). */
  linewise: boolean;
  /** True when the range end is inclusive (e, f, F). */
  inclusive: boolean;
}

/**
 * Resolve one motion (already count-adjusted by the caller repeating it).
 * Returns null when the motion cannot move (e.g. w at end of document).
 */
function resolveMotion(
  lines: string[],
  from: VimPos,
  key: string,
  findChar: string | null,
  count: number,
): MotionResult | null {
  let cur = from;
  for (let i = 0; i < count; i++) {
    let next: VimPos | null = null;
    let linewise = false;
    let inclusive = false;
    switch (key) {
      case 'h':
        next = cur.col > 0 ? { line: cur.line, col: cur.col - 1 } : null;
        break;
      case 'l':
        next = cur.col < lineLen(lines, cur.line) - 1 ? { line: cur.line, col: cur.col + 1 } : null;
        break;
      case 'j':
        next = cur.line < lines.length - 1 ? { line: cur.line + 1, col: cur.col } : null;
        break;
      case 'k':
        next = cur.line > 0 ? { line: cur.line - 1, col: cur.col } : null;
        break;
      case 'w':
        next = nextWordStart(lines, cur, false);
        break;
      case 'W':
        next = nextWordStart(lines, cur, true);
        break;
      case 'b':
        next = cur.line === 0 && cur.col === 0 ? null : prevWordStart(lines, cur, false);
        break;
      case 'B':
        next = cur.line === 0 && cur.col === 0 ? null : prevWordStart(lines, cur, true);
        break;
      case 'e':
        next = nextWordEnd(lines, cur, false);
        inclusive = true;
        break;
      case 'E':
        next = nextWordEnd(lines, cur, true);
        inclusive = true;
        break;
      case '0':
        next = { line: cur.line, col: 0 };
        break;
      case '^':
        next = { line: cur.line, col: firstNonBlank(lines, cur.line) };
        break;
      case '$':
        next = { line: cur.line, col: Math.max(0, lineLen(lines, cur.line) - 1) };
        inclusive = true;
        break;
      case 'f':
        next = findChar === null ? null : findCharOnLine(lines, cur, findChar, true, false);
        inclusive = true;
        break;
      case 'F':
        next = findChar === null ? null : findCharOnLine(lines, cur, findChar, false, false);
        inclusive = true;
        break;
      case 't':
        next = findChar === null ? null : findCharOnLine(lines, cur, findChar, true, true);
        break;
      case 'T':
        next = findChar === null ? null : findCharOnLine(lines, cur, findChar, false, true);
        break;
      case '%':
        next = matchBracket(lines, cur);
        inclusive = true;
        break;
      case 'gg':
        linewise = true;
        next = { line: 0, col: firstNonBlank(lines, 0) };
        break;
      case 'G':
        linewise = true;
        next = { line: lines.length - 1, col: firstNonBlank(lines, lines.length - 1) };
        break;
      default:
        return null;
    }
    if (next === null) {
      // Partial progress on a counted motion still counts as a move when
      // at least one step succeeded; otherwise the motion fails.
      if (i === 0) return null;
      return { to: clampNormal(lines, cur), linewise, inclusive };
    }
    cur = next;
    if (i === count - 1) return { to: clampNormal(lines, cur), linewise, inclusive };
  }
  return null;
}

function comparePos(a: VimPos, b: VimPos): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

/** Slice text between two positions (start inclusive, end exclusive). */
function sliceRange(lines: string[], from: VimPos, to: VimPos): string {
  if (from.line === to.line) return (lines[from.line] ?? '').slice(from.col, to.col);
  const parts: string[] = [(lines[from.line] ?? '').slice(from.col)];
  for (let l = from.line + 1; l < to.line; l++) parts.push(lines[l] ?? '');
  parts.push((lines[to.line] ?? '').slice(0, to.col));
  return parts.join('\n');
}

function rangeEdit(from: VimPos, to: VimPos, text: string): VimEdit {
  return { startLine: from.line, startCol: from.col, endLine: to.line, endCol: to.col, text };
}

function commit(state: VimState, edits: VimEdit[]): void {
  state.lines = applyEditsToLines(state.lines, edits);
}

function result(
  state: VimState,
  edits: VimEdit[],
  extra: Partial<VimKeyResult> = {},
): VimKeyResult {
  const selection =
    state.mode === 'visual' || state.mode === 'visualLine'
      ? { anchor: state.anchor ?? state.cursor, head: state.cursor }
      : null;
  return {
    handled: true,
    edits,
    cursor: { ...state.cursor },
    selection,
    mode: state.mode,
    commandLine: state.commandLine === '' ? null : state.commandLine,
    message: null,
    action: null,
    ...extra,
  };
}

/**
 * Handle one keystroke. The caller owns syncing state.lines/cursor from
 * the real editor before calling (see adapter.ts); this function never
 * reads the DOM.
 */
export function handleVimKey(state: VimState, input: VimKeyInput): VimKeyResult {
  const { key } = input;
  const modified = !!(input.ctrl || input.meta || input.alt);

  // Ctrl+[ is Esc everywhere; Ctrl+C cancels pending input in normal mode.
  if (input.ctrl && !input.meta && !input.alt && (key === '[' || key === 'c')) {
    if (state.mode === 'insert') {
      state.mode = 'normal';
      clearPending(state);
      state.cursor = clampNormal(state.lines, { ...state.cursor, col: state.cursor.col - 1 });
      state.commandLine = '';
      return result(state, []);
    }
    clearPending(state);
    if (state.mode === 'visual' || state.mode === 'visualLine') {
      state.mode = 'normal';
      state.anchor = null;
      state.cursor = clampNormal(state.lines, state.cursor);
    }
    state.commandLine = '';
    return result(state, []);
  }
  // Ctrl+R redo in normal mode; every other modified chord passes through
  // to the global keybinding registry (which-key, save, palette, ...).
  if (input.ctrl && !input.meta && !input.alt && key.toLowerCase() === 'r' && state.mode === 'normal') {
    clearPending(state);
    return result(state, [], { action: 'redo' });
  }
  if (modified) return { ...result(state, []), handled: false };

  if (state.mode === 'insert') return handleInsertKey(state, input);
  if (state.mode === 'visual' || state.mode === 'visualLine') return handleVisualKey(state, input);
  return handleNormalKey(state, input);
}

function handleInsertKey(state: VimState, input: VimKeyInput): VimKeyResult {
  const { key } = input;
  if (key === 'Escape') {
    state.mode = 'normal';
    state.cursor = clampNormal(state.lines, { ...state.cursor, col: state.cursor.col - 1 });
    return result(state, []);
  }
  if (key === 'Enter') {
    const { line, col } = state.cursor;
    const edit = rangeEdit({ line, col }, { line, col }, '\n');
    commit(state, [edit]);
    state.cursor = { line: line + 1, col: 0 };
    return result(state, [edit]);
  }
  if (key === 'Backspace') {
    const { line, col } = state.cursor;
    if (col > 0) {
      const edit = rangeEdit({ line, col: col - 1 }, { line, col }, '');
      commit(state, [edit]);
      state.cursor = { line, col: col - 1 };
      return result(state, [edit]);
    }
    if (line > 0) {
      const prevLen = lineLen(state.lines, line - 1);
      const edit = rangeEdit({ line: line - 1, col: prevLen }, { line, col: 0 }, '');
      commit(state, [edit]);
      state.cursor = { line: line - 1, col: prevLen };
      return result(state, [edit]);
    }
    return result(state, []);
  }
  if (key.length === 1) {
    const { line, col } = state.cursor;
    const edit = rangeEdit({ line, col }, { line, col }, key);
    commit(state, [edit]);
    state.cursor = { line, col: col + 1 };
    return result(state, [edit]);
  }
  // Arrows, Tab, Home/End and friends: let Monaco handle them; the
  // adapter resyncs lines/cursor before the next Vim keystroke.
  return { ...result(state, []), handled: false };
}

function handleVisualKey(state: VimState, input: VimKeyInput): VimKeyResult {
  const { key } = input;
  const linewise = state.mode === 'visualLine';
  if (key === 'Escape') {
    state.mode = 'normal';
    state.anchor = null;
    state.cursor = clampNormal(state.lines, state.cursor);
    return result(state, []);
  }
  if (key === 'v' && !linewise) {
    state.mode = 'normal';
    state.anchor = null;
    state.cursor = clampNormal(state.lines, state.cursor);
    return result(state, []);
  }
  if (key === 'V') {
    if (linewise) {
      state.mode = 'normal';
      state.anchor = null;
      state.cursor = clampNormal(state.lines, state.cursor);
      return result(state, []);
    }
    state.mode = 'visualLine';
    state.anchor = { line: state.anchor?.line ?? state.cursor.line, col: 0 };
    state.cursor = { line: state.cursor.line, col: 0 };
    return result(state, []);
  }
  if (key === 'o') {
    // Swap anchor and head.
    const anchor = state.anchor ?? state.cursor;
    state.anchor = { ...state.cursor };
    state.cursor = { ...anchor };
    return result(state, []);
  }
  if (key === 'd' || key === 'x' || key === 'y' || key === 'c') {
    const anchor = state.anchor ?? state.cursor;
    const head = state.cursor;
    const from = comparePos(anchor, head) <= 0 ? anchor : head;
    const to = comparePos(anchor, head) <= 0 ? head : anchor;
    let edits: VimEdit[] = [];
    if (linewise) {
      const top = Math.min(from.line, to.line);
      const bottom = Math.max(from.line, to.line);
      const text = state.lines.slice(top, bottom + 1).join('\n');
      state.register = { text, linewise: true };
      if (key !== 'y') {
        const endLine = bottom + 1 < state.lines.length ? bottom + 1 : bottom;
        const endCol = bottom + 1 < state.lines.length ? 0 : lineLen(state.lines, bottom);
        edits = [rangeEdit({ line: top, col: 0 }, { line: endLine, col: endCol }, '')];
        commit(state, edits);
        if (state.lines.length === 0) state.lines = [''];
        state.cursor = { line: Math.min(top, state.lines.length - 1), col: 0 };
        state.cursor.col = firstNonBlank(state.lines, state.cursor.line);
      }
    } else {
      const end: VimPos = { line: to.line, col: Math.min(to.col + 1, lineLen(state.lines, to.line)) };
      const text = sliceRange(state.lines, from, end);
      state.register = { text, linewise: false };
      if (key !== 'y') {
        edits = [rangeEdit(from, end, '')];
        commit(state, edits);
        state.cursor = clampNormal(state.lines, { ...from });
      }
    }
    state.mode = key === 'c' ? 'insert' : 'normal';
    state.anchor = null;
    clearPending(state);
    return result(state, edits);
  }
  if (/^[1-9]$/.test(key)) {
    state.count += key;
    return result(state, []);
  }
  // Motions extend the selection.
  const motion = motionFromKey(state, key);
  if (motion !== null) {
    // First half of a two-key motion (f/F/t/T awaiting its char, or the
    // first g of gg): keep the pending state, do not resolve yet.
    if (motion.key === '__pending__') return result(state, []);
    const count = countOf(state);
    const resolved = resolveMotion(state.lines, state.cursor, motion.key, motion.findChar, count);
    clearPending(state);
    if (resolved === null) return result(state, []);
    if (resolved.linewise || linewise) {
      state.cursor = { line: resolved.to.line, col: 0 };
    } else {
      state.cursor = resolved.to;
    }
    return result(state, []);
  }
  return { ...result(state, []), handled: false };
}

/** Map a pressed key to a motion key (+ f/t target char when pending). */
function motionFromKey(
  state: VimState,
  key: string,
): { key: string; findChar: string | null } | null {
  if (state.pendingFind !== '') {
    const find = state.pendingFind;
    state.pendingFind = '';
    return { key: find, findChar: key };
  }
  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    state.pendingFind = key as 'f' | 'F' | 't' | 'T';
    return { key: '__pending__', findChar: null };
  }
  if (key === 'g') {
    if (state.pendingG) {
      state.pendingG = false;
      return { key: 'gg', findChar: null };
    }
    state.pendingG = true;
    return { key: '__pending__', findChar: null };
  }
  if (['h', 'j', 'k', 'l', 'w', 'W', 'b', 'B', 'e', 'E', '0', '^', '$', '%', 'G'].includes(key)) {
    return { key, findChar: null };
  }
  return null;
}

function handleNormalKey(state: VimState, input: VimKeyInput): VimKeyResult {
  const { key } = input;

  // Ex command line in progress.
  if (state.commandLine !== '') {
    if (key === 'Escape') {
      state.commandLine = '';
      return result(state, []);
    }
    if (key === 'Enter') {
      const cmd = state.commandLine.slice(1);
      state.commandLine = '';
      if (cmd === 'w') return result(state, [], { action: 'save', message: 'saved via :w' });
      return result(state, [], { message: `E492: Not an editor command: ${cmd}` });
    }
    if (key === 'Backspace') {
      state.commandLine = state.commandLine.slice(0, -1);
      return result(state, []);
    }
    if (key.length === 1) {
      state.commandLine += key;
      return result(state, []);
    }
    return result(state, []);
  }

  // Pending r: next char is the replacement.
  if (state.pendingReplace) {
    state.pendingReplace = false;
    const count = countOf(state);
    clearPending(state);
    if (key.length !== 1) return result(state, []);
    const { line, col } = state.cursor;
    const len = lineLen(state.lines, line);
    const n = Math.min(count, Math.max(0, len - col));
    if (n <= 0) return result(state, []);
    const edit = rangeEdit({ line, col }, { line, col: col + n }, key.repeat(n));
    commit(state, [edit]);
    state.cursor = clampNormal(state.lines, { line, col });
    return result(state, [edit]);
  }

  // Pending f/F/t/T: this key is the target character.
  if (state.pendingFind !== '') {
    const find = state.pendingFind;
    state.pendingFind = '';
    const motion = { key: find, findChar: key };
    return applyMotionOrOperator(state, motion, countOf(state));
  }

  // Digits: '0' alone is a motion, other digits build the count.
  if (/^[0-9]$/.test(key)) {
    if (key === '0' && state.count === '') {
      return applyMotionOrOperator(state, { key: '0', findChar: null }, 1);
    }
    state.count += key;
    return result(state, []);
  }

  if (key === ':') {
    state.commandLine = ':';
    clearPending(state);
    return result(state, []);
  }
  if (key === 'u') {
    clearPending(state);
    return result(state, [], { action: 'undo' });
  }
  if (key === 'J') {
    const count = countOf(state);
    clearPending(state);
    const { line } = state.cursor;
    if (line >= state.lines.length - 1) return result(state, []);
    const joins = Math.min(count, state.lines.length - 1 - line);
    // Join with a single space between non-blank tails (Vim's J rule,
    // simplified: leading whitespace of joined lines is stripped).
    const tail = state.lines
      .slice(line + 1, line + joins + 1)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' ');
    const edit = rangeEdit(
      { line, col: lineLen(state.lines, line) },
      { line: line + joins, col: lineLen(state.lines, line + joins) },
      tail === '' ? '' : ` ${tail}`,
    );
    commit(state, [edit]);
    state.cursor = clampNormal(state.lines, { line, col: lineLen(state.lines, line) });
    return result(state, [edit]);
  }
  if (key === 'D' || key === 'C' || key === 'Y') {
    const count = countOf(state);
    clearPending(state);
    if (key === 'Y') {
      const top = state.cursor.line;
      const bottom = Math.min(top + count - 1, state.lines.length - 1);
      state.register = { text: state.lines.slice(top, bottom + 1).join('\n'), linewise: true };
      return result(state, []);
    }
    const from: VimPos = { ...state.cursor };
    const to: VimPos = { line: state.cursor.line, col: lineLen(state.lines, state.cursor.line) };
    if (key === 'D') {
      const edit = rangeEdit(from, to, '');
      commit(state, [edit]);
      state.cursor = clampNormal(state.lines, { ...from });
      return result(state, [edit]);
    }
    const edit = rangeEdit(from, to, '');
    commit(state, [edit]);
    state.mode = 'insert';
    state.cursor = { ...from };
    return result(state, [edit]);
  }
  if (key === 'x' || key === 'X') {
    const count = countOf(state);
    clearPending(state);
    const { line, col } = state.cursor;
    const len = lineLen(state.lines, line);
    if (key === 'x') {
      const n = Math.min(count, Math.max(0, len - col));
      if (n <= 0) return result(state, []);
      const edit = rangeEdit({ line, col }, { line, col: col + n }, '');
      commit(state, [edit]);
      state.cursor = clampNormal(state.lines, { line, col });
      return result(state, [edit]);
    }
    const n = Math.min(count, col);
    if (n <= 0) return result(state, []);
    const edit = rangeEdit({ line, col: col - n }, { line, col }, '');
    commit(state, [edit]);
    state.cursor = clampNormal(state.lines, { line, col: col - n });
    return result(state, [edit]);
  }
  if (key === 'r') {
    state.pendingReplace = true;
    return result(state, []);
  }
  if (key === 'p' || key === 'P') {
    clearPending(state);
    if (state.register.text === '') return result(state, []);
    const { line, col } = state.cursor;
    let edits: VimEdit[];
    if (state.register.linewise) {
      const at = key === 'p' ? line + 1 : line;
      const edit = rangeEdit({ line: at, col: 0 }, { line: at, col: 0 }, state.register.text + '\n');
      // Inserting at a line start past the end needs a trailing anchor:
      // when pasting below the last line, append instead.
      if (at >= state.lines.length) {
        const last = state.lines.length - 1;
        edits = [rangeEdit({ line: last, col: lineLen(state.lines, last) }, { line: last, col: lineLen(state.lines, last) }, `\n${state.register.text}`)];
        commit(state, edits);
        state.cursor = { line: last + 1, col: firstNonBlank(state.lines, last + 1) };
      } else {
        edits = [edit];
        commit(state, edits);
        state.cursor = { line: at, col: firstNonBlank(state.lines, at) };
      }
    } else {
      if (key === 'p') {
        const at: VimPos = lineLen(state.lines, line) === 0 ? { line, col: 0 } : { line, col: col + 1 };
        edits = [rangeEdit(at, at, state.register.text)];
        commit(state, edits);
        state.cursor = clampNormal(state.lines, { line, col: at.col + state.register.text.length - 1 });
      } else {
        edits = [rangeEdit({ line, col }, { line, col }, state.register.text)];
        commit(state, edits);
        state.cursor = clampNormal(state.lines, { line, col: col + state.register.text.length - 1 });
      }
    }
    return result(state, edits);
  }
  if (key === 'i' || key === 'a' || key === 'A' || key === 'I' || key === 'o' || key === 'O') {
    clearPending(state);
    const { line, col } = state.cursor;
    if (key === 'i') {
      state.mode = 'insert';
      return result(state, []);
    }
    if (key === 'a') {
      state.mode = 'insert';
      state.cursor = clampInsert(state.lines, { line, col: col + 1 });
      return result(state, []);
    }
    if (key === 'A') {
      state.mode = 'insert';
      state.cursor = { line, col: lineLen(state.lines, line) };
      return result(state, []);
    }
    if (key === 'I') {
      state.mode = 'insert';
      state.cursor = { line, col: firstNonBlank(state.lines, line) };
      return result(state, []);
    }
    if (key === 'o') {
      const edit = rangeEdit({ line, col: lineLen(state.lines, line) }, { line, col: lineLen(state.lines, line) }, '\n');
      commit(state, [edit]);
      state.mode = 'insert';
      state.cursor = { line: line + 1, col: 0 };
      return result(state, [edit]);
    }
    const edit = rangeEdit({ line, col: 0 }, { line, col: 0 }, '\n');
    commit(state, [edit]);
    state.mode = 'insert';
    state.cursor = { line, col: 0 };
    return result(state, [edit]);
  }
  if (key === 'v') {
    clearPending(state);
    state.mode = 'visual';
    state.anchor = { ...state.cursor };
    return result(state, []);
  }
  if (key === 'V') {
    clearPending(state);
    state.mode = 'visualLine';
    state.anchor = { line: state.cursor.line, col: 0 };
    state.cursor = { line: state.cursor.line, col: 0 };
    return result(state, []);
  }
  if (key === 'Escape') {
    clearPending(state);
    return result(state, []);
  }
  // Operators.
  if (key === 'd' || key === 'c' || key === 'y') {
    if (state.operator === key) {
      // Doubled: linewise operation over count lines.
      const count = countOf(state);
      const top = state.cursor.line;
      const bottom = Math.min(top + count - 1, state.lines.length - 1);
      const text = state.lines.slice(top, bottom + 1).join('\n');
      state.register = { text, linewise: true };
      clearPending(state);
      if (key === 'y') return result(state, []);
      const endLine = bottom + 1 < state.lines.length ? bottom + 1 : bottom;
      const endCol = bottom + 1 < state.lines.length ? 0 : lineLen(state.lines, bottom);
      const edits = [rangeEdit({ line: top, col: 0 }, { line: endLine, col: endCol }, key === 'c' ? '' : '')];
      commit(state, edits);
      if (state.lines.length === 0) state.lines = [''];
      if (key === 'c') {
        state.mode = 'insert';
        state.cursor = { line: top, col: 0 };
      } else {
        state.cursor = { line: Math.min(top, state.lines.length - 1), col: 0 };
        state.cursor.col = firstNonBlank(state.lines, state.cursor.line);
      }
      return result(state, edits);
    }
    state.operator = key as 'd' | 'c' | 'y';
    return result(state, []);
  }
  // g / gg.
  if (key === 'g') {
    if (state.pendingG) {
      state.pendingG = false;
      const count = countOf(state);
      clearPending(state);
      const line = Math.min(count - 1, state.lines.length - 1);
      state.cursor = { line, col: firstNonBlank(state.lines, line) };
      return result(state, []);
    }
    state.pendingG = true;
    return result(state, []);
  }
  // f/F/t/T set the pending finder; the target char comes next.
  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    state.pendingFind = key as 'f' | 'F' | 't' | 'T';
    return result(state, []);
  }
  // Plain motions (with or without a pending operator).
  if (['h', 'j', 'k', 'l', 'w', 'W', 'b', 'B', 'e', 'E', '^', '$', '%', 'G'].includes(key)) {
    return applyMotionOrOperator(state, { key, findChar: null }, countOf(state));
  }
  // Anything else in normal mode is swallowed (Vim beeps; the buffer
  // must not receive it). Arrows/Home/End/Page keys are NOT swallowed:
  // they are multi-char key names and fall through to Monaco.
  if (key.length === 1) return result(state, []);
  return { ...result(state, []), handled: false };
}

/**
 * Apply a motion, either as a pure move or as the range of a pending
 * operator (d/c/y). Consumes the pending operator/count on success.
 */
function applyMotionOrOperator(
  state: VimState,
  motion: { key: string; findChar: string | null },
  count: number,
): VimKeyResult {
  const from: VimPos = { ...state.cursor };
  const op = state.operator;
  if (motion.key === '__pending__') return result(state, []);
  let resolved: MotionResult | null;
  if (motion.key === 'G') {
    const line = op === '' && state.count !== '' ? Math.min(count - 1, state.lines.length - 1) : state.lines.length - 1;
    resolved = { to: { line, col: firstNonBlank(state.lines, line) }, linewise: true, inclusive: false };
  } else if (motion.key === 'gg') {
    const line = Math.min(count - 1, state.lines.length - 1);
    resolved = { to: { line, col: firstNonBlank(state.lines, line) }, linewise: true, inclusive: false };
  } else {
    resolved = resolveMotion(state.lines, from, motion.key, motion.findChar, count);
  }
  if (resolved === null) {
    // Failed motion: for dw-style operators at end of text, delete to
    // end of line (Vim's dw-at-EOL behavior); otherwise just cancel.
    if (op !== '' && (motion.key === 'w' || motion.key === 'W')) {
      const to: VimPos = { line: from.line, col: lineLen(state.lines, from.line) };
      const text = sliceRange(state.lines, from, to);
      state.register = { text, linewise: false };
      clearPending(state);
      if (op === 'y') return result(state, []);
      const edits = [rangeEdit(from, to, '')];
      commit(state, edits);
      state.cursor = clampNormal(state.lines, { ...from });
      if (op === 'c') {
        state.mode = 'insert';
        state.cursor = { ...from };
      }
      return result(state, edits);
    }
    clearPending(state);
    return result(state, []);
  }
  if (op === '') {
    clearPending(state);
    state.cursor = resolved.to;
    return result(state, []);
  }
  // Operator + motion.
  let to = resolved.to;
  if (resolved.linewise) {
    const top = Math.min(from.line, to.line);
    const bottom = Math.max(from.line, to.line);
    const text = state.lines.slice(top, bottom + 1).join('\n');
    state.register = { text, linewise: true };
    clearPending(state);
    if (op === 'y') return result(state, []);
    const endLine = bottom + 1 < state.lines.length ? bottom + 1 : bottom;
    const endCol = bottom + 1 < state.lines.length ? 0 : lineLen(state.lines, bottom);
    const edits = [rangeEdit({ line: top, col: 0 }, { line: endLine, col: endCol }, '')];
    commit(state, edits);
    if (state.lines.length === 0) state.lines = [''];
    if (op === 'c') {
      state.mode = 'insert';
      state.cursor = { line: top, col: 0 };
    } else {
      state.cursor = { line: Math.min(top, state.lines.length - 1), col: 0 };
      state.cursor.col = firstNonBlank(state.lines, state.cursor.line);
    }
    return result(state, edits);
  }
  // Charwise range: order endpoints, apply inclusive/exclusive rules.
  let start = from;
  let end = to;
  let backward = false;
  if (comparePos(from, to) > 0) {
    start = to;
    end = from;
    backward = true;
  }
  if (resolved.inclusive) {
    end = { line: end.line, col: Math.min(end.col + 1, lineLen(state.lines, end.line)) };
  } else if (end.line > start.line) {
    // Exclusive motion spanning lines: stop at end of the start line
    // (Vim's dw-across-lines rule).
    end = { line: start.line, col: lineLen(state.lines, start.line) };
  }
  void backward;
  const text = sliceRange(state.lines, start, end);
  state.register = { text, linewise: false };
  clearPending(state);
  if (op === 'y') return result(state, []);
  const edits = [rangeEdit(start, end, '')];
  commit(state, edits);
  if (op === 'c') {
    state.mode = 'insert';
    state.cursor = { ...start };
  } else {
    state.cursor = clampNormal(state.lines, { ...start });
  }
  return result(state, edits);
}

/* ------------------------------------------------------------------ */
/* Monaco adapter (same file so desktop unit tests can import it        */
/* without a relative value import, which bundler-mode tsc forbids     */
/* with a .ts suffix and type-stripping cannot resolve bare).          */
/* ------------------------------------------------------------------ */
/** Minimal editor surface the controller needs (Monaco satisfies it). */
export interface VimEditorLike {
  getValue(): string;
  executeEdits(source: string, edits: Array<{ range: VimMonacoRange; text: string }>): void;
  setPosition(pos: { lineNumber: number; column: number }): void;
  setSelection(sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }): void;
  getPosition(): { lineNumber: number; column: number } | null;
  trigger(source: string, handlerId: string, payload: unknown): void;
  updateOptions(opts: { cursorStyle?: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin' }): void;
}

export interface VimMonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface VimControllerCallbacks {
  onModeChange(mode: VimMode): void;
  onMessage(message: string | null): void;
  onSave(): void;
  /** Ex command-line echo (':w') while typing, else null. Optional. */
  onCommandLine?: (commandLine: string | null) => void;
}

function toMonacoRange(edit: VimEdit): VimMonacoRange {
  return {
    startLineNumber: edit.startLine + 1,
    startColumn: edit.startCol + 1,
    endLineNumber: edit.endLine + 1,
    endColumn: edit.endCol + 1,
  };
}

export class VimController {
  private state: VimState;
  private applying = false;
  private readonly editor: VimEditorLike;
  private readonly cb: VimControllerCallbacks;

  constructor(editor: VimEditorLike, cb: VimControllerCallbacks) {
    this.editor = editor;
    this.cb = cb;
    this.state = createVimState(editor.getValue());
  }

  get mode(): VimMode {
    return this.state.mode;
  }

  /** True while the controller is applying its own edits/cursor moves. */
  isApplying(): boolean {
    return this.applying;
  }

  /** Call when a new file is opened: fresh state, normal mode. */
  reset(text: string): void {
    this.state = createVimState(text);
    this.cb.onModeChange('normal');
    this.cb.onMessage(null);
    this.editor.updateOptions({ cursorStyle: 'block' });
  }

  /** Call when Vim mode is switched off: restore the line cursor. */
  suspend(): void {
    this.editor.updateOptions({ cursorStyle: 'line' });
    this.cb.onMessage(null);
  }

  /**
   * Handle one keystroke from Monaco's onKeyDown. Returns true when the
   * key was consumed (the caller must preventDefault/stopPropagation).
   * The input key uses KeyboardEvent.key semantics ('Escape', 'Enter',
   * 'Backspace', single chars, 'ArrowLeft', ...).
   */
  handleKey(input: VimKeyInput): boolean {
    if (this.applying) return false;
    this.resync();
    const before = this.state.mode;
    const res = handleVimKey(this.state, input);
    if (!res.handled) return false;
    this.applying = true;
    try {
      if (res.edits.length > 0) {
        this.editor.executeEdits(
          'vim',
          res.edits.map((e) => ({ range: toMonacoRange(e), text: e.text })),
        );
      }
      if (res.selection) {
        const a = res.selection.anchor;
        const h = res.selection.head;
        // Monaco selections are ordered; anchor/head order is restored
        // by which endpoint the cursor sits on, which setSelection
        // encodes via start/end + cursor position below.
        const start = a.line < h.line || (a.line === h.line && a.col <= h.col) ? a : h;
        const end = start === a ? h : a;
        this.editor.setSelection({
          startLineNumber: start.line + 1,
          startColumn: start.col + 1,
          endLineNumber: end.line + 1,
          endColumn: end.col + 1,
        });
        this.editor.setPosition({ lineNumber: h.line + 1, column: h.col + 1 });
      } else {
        this.editor.setPosition({ lineNumber: res.cursor.line + 1, column: res.cursor.col + 1 });
      }
      if (res.action === 'undo') this.editor.trigger('vim', 'undo', null);
      else if (res.action === 'redo') this.editor.trigger('vim', 'redo', null);
      else if (res.action === 'save') this.cb.onSave();
      if (res.action === 'undo' || res.action === 'redo') {
        // Undo/redo changed the buffer behind the engine's back.
        this.state = createVimState(this.editor.getValue());
        const pos = this.editor.getPosition();
        if (pos) this.state.cursor = { line: pos.lineNumber - 1, col: Math.max(0, pos.column - 1) };
      }
    } finally {
      this.applying = false;
    }
    if (res.mode !== before) {
      this.cb.onModeChange(res.mode);
      this.editor.updateOptions({
        cursorStyle: res.mode === 'insert' ? 'line' : 'block',
      });
    }
    this.cb.onMessage(res.message);
    this.cb.onCommandLine?.(res.commandLine);
    return true;
  }

  /**
   * Resync engine lines/cursor from the editor. Called before every key
   * and by the panel after external edits; pending operator/count state
   * is intentionally preserved (Vim keeps it across cursor moves), while
   * a mouse click clears it via cancelPending().
   */
  resync(): void {
    const text = this.editor.getValue();
    this.state.lines = text.split('\n');
    const pos = this.editor.getPosition();
    if (pos) {
      const line = Math.max(0, Math.min(pos.lineNumber - 1, this.state.lines.length - 1));
      const maxCol = Math.max(0, (this.state.lines[line] ?? '').length - 1);
      const col = Math.max(0, pos.column - 1);
      this.state.cursor =
        this.state.mode === 'insert'
          ? { line, col: Math.min(col, (this.state.lines[line] ?? '').length) }
          : { line, col: Math.min(col, maxCol) };
    }
  }

  /** Mouse click / explicit cursor move cancels a pending operator. */
  cancelPending(): void {
    this.state.count = '';
    this.state.operator = '';
    this.state.pendingFind = '';
    this.state.pendingG = false;
    this.state.pendingReplace = false;
  }

  /** Test seam: current engine state (read-only snapshot). */
  snapshot(): VimState {
    return this.state;
  }
}
