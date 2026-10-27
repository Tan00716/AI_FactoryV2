/**
 * Desktop unit tests for the Vim key layer (round-6 R6-B9).
 * node:test + node:assert/strict. React-free engine + adapter, no DOM:
 * the adapter is driven with a mock editor implementing VimEditorLike.
 * Run: node --test apps/desktop/tests/unit/vim.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const vim = await import('../../src/vim.ts');
const { createVimState, handleVimKey, applyEditsToLines, VimController } = vim;

/** Feed keys through the engine; verify returned edits reproduce state. */
function runKeys(text, keys, startCursor) {
  const state = createVimState(text);
  if (startCursor) state.cursor = startCursor;
  let parallel = text.split('\n');
  let last = null;
  for (const k of keys) {
    const input = typeof k === 'string' ? { key: k } : k;
    last = handleVimKey(state, input);
    parallel = applyEditsToLines(parallel, last.edits);
    assert.deepEqual(state.lines, parallel, `edits diverge after key ${JSON.stringify(k)}`);
  }
  return { state, last };
}

function textOf(state) {
  return state.lines.join('\n');
}

test('h/j/k/l clamp at edges', () => {
  const { state } = runKeys('ab\ncd', ['h', 'l', 'l', 'j', 'j', 'k', 'k']);
  assert.deepEqual(state.cursor, { line: 0, col: 1 });
});

test('w/b/e word motions with punctuation runs', () => {
  const { state } = runKeys('foo bar, baz', ['w']);
  assert.deepEqual(state.cursor, { line: 0, col: 4 });
  const s2 = runKeys('foo bar, baz', ['w', 'w']);
  assert.deepEqual(s2.state.cursor, { line: 0, col: 7 }); // ',' is its own word
  const s2b = runKeys('foo bar, baz', ['w', 'w', 'w']);
  assert.deepEqual(s2b.state.cursor, { line: 0, col: 9 }); // then 'baz'
  const s3 = runKeys('foo bar, baz', ['w', 'w', 'b']);
  assert.deepEqual(s3.state.cursor, { line: 0, col: 4 }); // back to start of 'bar'
});

test('w crosses lines, b returns', () => {
  const { state } = runKeys('foo\nbar', ['w']);
  assert.deepEqual(state.cursor, { line: 1, col: 0 });
  const s2 = runKeys('foo\nbar', ['w', 'b']);
  assert.deepEqual(s2.state.cursor, { line: 0, col: 0 });
});

test('e lands on word end, E on WORD end', () => {
  const { state } = runKeys('foo bar-baz', ['e']);
  assert.deepEqual(state.cursor, { line: 0, col: 2 });
  const s2 = runKeys('foo bar-baz', ['w', 'E']);
  assert.deepEqual(s2.state.cursor, { line: 0, col: 10 }); // WORD end, past '-'
  const s3 = runKeys('foo bar-baz', ['w', 'e']);
  assert.deepEqual(s3.state.cursor, { line: 0, col: 6 }); // word end stops at '-'
});

test('0 ^ $ and counts', () => {
  const { state } = runKeys('  foo bar', ['$', '0']);
  assert.deepEqual(state.cursor, { line: 0, col: 0 });
  const s2 = runKeys('  foo bar', ['^']);
  assert.deepEqual(s2.state.cursor, { line: 0, col: 2 });
  const s3 = runKeys('a b c d', ['3', 'w']);
  assert.deepEqual(s3.state.cursor, { line: 0, col: 6 });
});

test('gg/G with and without count', () => {
  const doc = 'one\ntwo\nthree\nfour';
  assert.deepEqual(runKeys(doc, ['G']).state.cursor, { line: 3, col: 0 });
  assert.deepEqual(runKeys(doc, ['2', 'G']).state.cursor, { line: 1, col: 0 });
  assert.deepEqual(runKeys(doc, ['G', 'g', 'g']).state.cursor, { line: 0, col: 0 });
});

test('f/t/F/T motions', () => {
  assert.deepEqual(runKeys('foo bar', ['f', 'a']).state.cursor, { line: 0, col: 5 });
  assert.deepEqual(runKeys('foo bar', ['t', 'a']).state.cursor, { line: 0, col: 4 });
  assert.deepEqual(runKeys('foo bar', ['$', 'F', 'o']).state.cursor, { line: 0, col: 2 }); // nearest 'o' back
  assert.deepEqual(runKeys('foo bar', ['$', 'T', 'o']).state.cursor, { line: 0, col: 3 }); // one before it
});

test('% matches brackets with nesting', () => {
  const { state } = runKeys('f((a)b)', ['%'], { line: 0, col: 1 });
  assert.deepEqual(state.cursor, { line: 0, col: 6 });
  const s2 = runKeys('f((a)b)', ['%', '%'], { line: 0, col: 1 });
  assert.deepEqual(s2.state.cursor, { line: 0, col: 1 });
});

test('dw deletes to next word start, d$ through end of line', () => {
  assert.equal(textOf(runKeys('foo bar baz', ['d', 'w']).state), 'bar baz');
  assert.equal(textOf(runKeys('foo bar baz', ['w', 'd', '$']).state), 'foo ');
  assert.equal(textOf(runKeys('foo bar', ['d', 'w', 'd', 'w']).state), '');
});

test('dw at end of text deletes to end of line', () => {
  assert.equal(textOf(runKeys('foo bar', ['w', 'w', 'd', 'w']).state), 'foo ');
});

test('dd/2dd linewise delete, cursor re-clamped', () => {
  assert.equal(textOf(runKeys('a\nb\nc', ['d', 'd']).state), 'b\nc');
  assert.equal(textOf(runKeys('a\nb\nc', ['2', 'd', 'd']).state), 'c');
  const { state } = runKeys('a\nb\nc', ['j', 'd', 'd']);
  assert.deepEqual(state.cursor, { line: 1, col: 0 });
});

test('yw + p charwise paste, yy + p linewise paste', () => {
  const { state } = runKeys('foo bar', ['y', 'w', 'w', 'p']);
  assert.equal(textOf(state), 'foo bfoo ar');
  const s2 = runKeys('a\nb', ['y', 'y', 'p']);
  assert.equal(textOf(s2.state), 'a\na\nb');
  const s3 = runKeys('a\nb', ['y', 'y', 'P']);
  assert.equal(textOf(s3.state), 'a\na\nb');
});

test('cc replaces line with insert mode, D/C/Y aliases', () => {
  const { state } = runKeys('foo bar', ['c', 'c']);
  assert.equal(state.mode, 'insert');
  assert.equal(textOf(state), '');
  assert.equal(textOf(runKeys('foo bar', ['w', 'D']).state), 'foo ');
  assert.equal(textOf(runKeys('foo bar', ['w', 'C']).state), 'foo ');
  assert.equal(runKeys('foo bar', ['C']).state.mode, 'insert');
  const sY = runKeys('a\nb', ['Y', 'j', 'p']);
  assert.equal(textOf(sY.state), 'a\nb\na');
});

test('x/X/r with counts', () => {
  assert.equal(textOf(runKeys('abcdef', ['2', 'x']).state), 'cdef');
  assert.equal(textOf(runKeys('abcdef', ['$', '2', 'X']).state), 'abcf'); // keeps cursor char
  assert.equal(textOf(runKeys('abcdef', ['2', 'r', 'z']).state), 'zzcdef');
});

test('i/a/A/I/o/O enter insert at the right spot', () => {
  const doc = 'foo\nbar';
  assert.deepEqual(runKeys(doc, ['a']).state.cursor, { line: 0, col: 1 });
  assert.deepEqual(runKeys(doc, ['A']).state.cursor, { line: 0, col: 3 });
  assert.deepEqual(runKeys(doc, ['I']).state.cursor, { line: 0, col: 0 });
  assert.deepEqual(runKeys(doc, ['o']).state.cursor, { line: 1, col: 0 });
  assert.equal(textOf(runKeys(doc, ['o']).state), 'foo\n\nbar');
  assert.equal(textOf(runKeys(doc, ['O']).state), '\nfoo\nbar');
});

test('insert mode typing, Enter, Backspace join, Esc backs up', () => {
  const { state } = runKeys('ab', ['i', 'X', 'Y']);
  assert.equal(textOf(state), 'XYab'); // i inserts AT the cursor
  const s2 = runKeys('ab', ['i', 'X', 'Escape']);
  assert.deepEqual(s2.state.cursor, { line: 0, col: 0 }); // Esc backs onto the inserted char
  assert.equal(s2.state.mode, 'normal');
  const s3 = runKeys('ab\ncd', ['j', 'i', 'Backspace']);
  assert.equal(textOf(s3.state), 'abcd');
  const s4 = runKeys('ab', ['A', 'Enter', 'z']);
  assert.equal(textOf(s4.state), 'ab\nz');
});

test('J joins lines with a single space', () => {
  assert.equal(textOf(runKeys('foo\n  bar\nbaz', ['J']).state), 'foo bar\nbaz');
});

test('visual char: v + motion + d/y, o swaps anchor', () => {
  const { state } = runKeys('abcdef', ['v', 'l', 'l', 'd']);
  assert.equal(textOf(state), 'def');
  const s2 = runKeys('abcdef', ['v', 'l', 'l', 'y', 'Escape', 'p']);
  assert.equal(textOf(s2.state), 'abcabcdef');
  const s3 = runKeys('abcdef', ['v', 'l', 'l', 'o']);
  assert.deepEqual(s3.state.cursor, { line: 0, col: 0 });
});

test('visual line: V + j + d deletes whole lines', () => {
  const { state } = runKeys('a\nb\nc\nd', ['V', 'j', 'd']);
  assert.equal(textOf(state), 'c\nd');
  const s2 = runKeys('a\nb\nc', ['V', 'y', 'p']);
  assert.equal(textOf(s2.state), 'a\na\nb\nc');
});

test(':w triggers save action, unknown Ex errors, Esc cancels', () => {
  const { last } = runKeys('x', [':', 'w', 'Enter']);
  assert.equal(last.action, 'save');
  const s2 = runKeys('x', [':', 'q', 'Enter']);
  assert.match(s2.last.message, /E492/);
  const s3 = runKeys('x', [':', 'w', 'Escape', 'x']);
  assert.equal(s3.last.handled, true);
  assert.equal(textOf(s3.state), '');
});

test('u returns undo action, Ctrl+R returns redo action', () => {
  assert.equal(runKeys('x', ['u']).last.action, 'undo');
  assert.equal(runKeys('x', [{ key: 'r', ctrl: true }]).last.action, 'redo');
});

test('unknown normal keys are swallowed, arrows pass through', () => {
  const { state, last } = runKeys('ab', ['q']);
  assert.equal(last.handled, true);
  assert.equal(textOf(state), 'ab');
  const s2 = runKeys('ab', ['ArrowLeft']);
  assert.equal(s2.last.handled, false);
});

test('operator + f/t motions', () => {
  assert.equal(textOf(runKeys('foo bar', ['d', 'f', 'a']).state), 'r');
  assert.equal(textOf(runKeys('foo bar', ['d', 't', 'a']).state), 'bar');
});

/* ---------------- adapter with a mock editor ---------------- */

function makeMockEditor(text) {
  const ed = {
    text,
    position: { lineNumber: 1, column: 1 },
    selection: null,
    triggers: [],
    cursorStyles: [],
    getValue() {
      return this.text;
    },
    executeEdits(_source, edits) {
      const lines = this.text.split('\n');
      for (const e of edits) {
        const before = lines.slice(0, e.range.startLineNumber - 1);
        const after = lines.slice(e.range.endLineNumber);
        const first = lines[e.range.startLineNumber - 1] ?? '';
        const lastLine = lines[e.range.endLineNumber - 1] ?? '';
        const middle = first.slice(0, e.range.startColumn - 1) + e.text + lastLine.slice(e.range.endColumn - 1);
        this.text = [...before, ...middle.split('\n'), ...after].join('\n');
      }
    },
    setPosition(pos) {
      this.position = pos;
    },
    setSelection(sel) {
      this.selection = sel;
      this.position = { lineNumber: sel.endLineNumber, column: sel.endColumn };
    },
    getPosition() {
      return this.position;
    },
    trigger(_source, handlerId) {
      this.triggers.push(handlerId);
      if (handlerId === 'undo') this.text = 'undone';
    },
    updateOptions(opts) {
      if (opts.cursorStyle) this.cursorStyles.push(opts.cursorStyle);
    },
  };
  return ed;
}

test('adapter: dw through Monaco surface, mode + cursor style updates', () => {
  const ed = makeMockEditor('foo bar');
  const modes = [];
  const ctrl = new VimController(ed, {
    onModeChange: (m) => modes.push(m),
    onMessage: () => {},
    onSave: () => {},
  });
  ctrl.reset('foo bar');
  assert.equal(ctrl.handleKey({ key: 'd' }), true);
  assert.equal(ctrl.handleKey({ key: 'w' }), true);
  assert.equal(ed.text, 'bar');
  assert.deepEqual(ed.position, { lineNumber: 1, column: 1 });
  assert.ok(ed.cursorStyles.includes('block'));
});

test('adapter: :w calls onSave, u triggers undo and resyncs', () => {
  const ed = makeMockEditor('hello');
  let saved = 0;
  const ctrl = new VimController(ed, {
    onModeChange: () => {},
    onMessage: () => {},
    onSave: () => saved++,
  });
  ctrl.reset('hello');
  ctrl.handleKey({ key: ':' });
  ctrl.handleKey({ key: 'w' });
  ctrl.handleKey({ key: 'Enter' });
  assert.equal(saved, 1);
  ctrl.handleKey({ key: 'u' });
  assert.ok(ed.triggers.includes('undo'));
  assert.equal(ed.text, 'undone');
});

test('adapter: external edit resyncs before the next key', () => {
  const ed = makeMockEditor('foo bar');
  const ctrl = new VimController(ed, {
    onModeChange: () => {},
    onMessage: () => {},
    onSave: () => {},
  });
  ctrl.reset('foo bar');
  ed.text = 'foo bar baz';
  ed.position = { lineNumber: 1, column: 5 };
  ctrl.handleKey({ key: 'd' });
  ctrl.handleKey({ key: 'w' });
  assert.equal(ed.text, 'foo baz');
});

test('adapter: insert-mode cursor style flips to line', () => {
  const ed = makeMockEditor('ab');
  const ctrl = new VimController(ed, {
    onModeChange: () => {},
    onMessage: () => {},
    onSave: () => {},
  });
  ctrl.reset('ab');
  ctrl.handleKey({ key: 'i' });
  assert.equal(ed.cursorStyles[ed.cursorStyles.length - 1], 'line');
  ctrl.handleKey({ key: 'Escape' });
  assert.equal(ed.cursorStyles[ed.cursorStyles.length - 1], 'block');
});
