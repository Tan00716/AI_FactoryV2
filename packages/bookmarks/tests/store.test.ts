/**
 * @ai-factory/bookmarks store tests — run against the compiled dist:
 *   node --test packages/bookmarks/dist/tests/store.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  addBookmark,
  relocateLine,
  removeBookmark,
  updateBookmark,
  validateBookmarkInput,
  type Bookmark,
} from '../src/index.js';

const hashLines = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');

const textOf = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1} content`).join('\n');

describe('validateBookmarkInput', () => {
  it('accepts a valid line bookmark', () => {
    assert.deepEqual(validateBookmarkInput({ kind: 'line', path: 'a/b.ts', line: 3, mnemonic: '5' }), []);
  });
  it('rejects bad kind, empty path, traversal, bad mnemonic', () => {
    assert.ok(validateBookmarkInput({ kind: 'x', path: 'a' }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'file', path: '' }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'file', path: '../etc/passwd' }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'line', path: 'a', line: 0 }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'file', path: 'a', line: 3 }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'dir', path: 'a', mnemonic: 'AB' }).length > 0);
    assert.ok(validateBookmarkInput({ kind: 'dir', path: 'a', mnemonic: '!' }).length > 0);
  });
});

describe('addBookmark', () => {
  it('captures context hash for line bookmarks', () => {
    const text = textOf(20);
    const { bookmark, issues } = addBookmark({
      existing: [],
      input: { kind: 'line', path: 'src/a.ts', line: 10, mnemonic: '5', label: 'hot' },
      fileText: text,
      hashLines,
      now: () => 1234,
      makeId: () => 'bm_1',
    });
    assert.deepEqual(issues, []);
    assert.equal(bookmark!.id, 'bm_1');
    assert.equal(bookmark!.contextLines!.length, 5);
    assert.equal(bookmark!.contextHash, hashLines(bookmark!.contextLines!));
    assert.equal(bookmark!.contextLines![2], 'line 10 content');
  });
  it('fails closed on duplicate mnemonic', () => {
    const existing: Bookmark[] = [
      { id: 'x', kind: 'file', path: 'a', label: 'a', tags: [], mnemonic: '5', createdAt: 1 },
    ];
    const { issues } = addBookmark({
      existing,
      input: { kind: 'file', path: 'b', mnemonic: '5' },
      hashLines,
    });
    assert.match(issues.join(' '), /already used/);
  });
  it('fails closed on identical bookmark and requires fileText for line kind', () => {
    const existing: Bookmark[] = [
      { id: 'x', kind: 'line', path: 'a', line: 3, label: 'a', tags: [], createdAt: 1 },
    ];
    assert.ok(
      addBookmark({ existing, input: { kind: 'line', path: 'a', line: 3 }, fileText: textOf(5), hashLines }).issues.length > 0,
    );
    assert.ok(
      addBookmark({ existing: [], input: { kind: 'line', path: 'a', line: 3 }, hashLines }).issues.length > 0,
    );
  });
  it('enforces the per-root cap', () => {
    const existing: Bookmark[] = Array.from({ length: 500 }, (_, i) => ({
      id: `b${i}`, kind: 'file' as const, path: `f${i}`, label: `f${i}`, tags: [], createdAt: 1,
    }));
    const { issues } = addBookmark({ existing, input: { kind: 'file', path: 'z' }, hashLines });
    assert.match(issues.join(' '), /limit reached/);
  });
});

describe('relocateLine', () => {
  const make = (line: number, text: string): Bookmark => {
    const lines = text.split('\n');
    const idx = line - 1;
    const ctx = lines.slice(Math.max(0, idx - 2), idx + 3);
    return {
      id: 'b', kind: 'line', path: 'a', line, label: 'a', tags: [],
      contextLines: ctx, contextHash: hashLines(ctx), createdAt: 1,
    };
  };
  it('returns ok when nothing changed', () => {
    const text = textOf(20);
    const r = relocateLine(text, make(10, text), hashLines);
    assert.deepEqual(r, { status: 'ok', line: 10 });
  });
  it('relocates when lines were inserted above', () => {
    const text = textOf(20);
    const bm = make(10, text);
    const shifted = ['new top', 'another', text].join('\n');
    const r = relocateLine(shifted, bm, hashLines);
    assert.deepEqual(r, { status: 'relocated', line: 12 });
  });
  it('reports drifted when the context vanished', () => {
    const text = textOf(20);
    const bm = make(10, text);
    const rewritten = Array.from({ length: 20 }, (_, i) => `totally different ${i}`).join('\n');
    const r = relocateLine(rewritten, bm, hashLines);
    assert.equal(r.status, 'drifted');
    assert.equal(r.line, 10);
  });
  it('legacy bookmarks without context are trusted but marked ok (honest)', () => {
    const bm: Bookmark = { id: 'b', kind: 'line', path: 'a', line: 999, label: 'a', tags: [], createdAt: 1 };
    const r = relocateLine(textOf(5), bm, hashLines);
    assert.equal(r.status, 'ok');
    assert.equal(r.line, 5); // clamped into range
  });
});

describe('removeBookmark / updateBookmark', () => {
  it('removes by id, null when missing', () => {
    const list: Bookmark[] = [{ id: 'a', kind: 'file', path: 'x', label: 'x', tags: [], createdAt: 1 }];
    assert.equal(removeBookmark(list, 'a')!.id, 'a');
    assert.equal(list.length, 0);
    assert.equal(removeBookmark(list, 'a'), null);
  });
  it('updates label/tags, clears mnemonic with null, rejects clashes', () => {
    const list: Bookmark[] = [
      { id: 'a', kind: 'file', path: 'x', label: 'x', tags: [], mnemonic: '1', createdAt: 1 },
      { id: 'b', kind: 'file', path: 'y', label: 'y', tags: [], mnemonic: '2', createdAt: 1 },
    ];
    const ok = updateBookmark(list, 'a', { label: 'new', tags: ['t'], mnemonic: null });
    assert.deepEqual(ok.issues, []);
    assert.equal(ok.bookmark!.label, 'new');
    assert.equal(ok.bookmark!.mnemonic, undefined);
    const clash = updateBookmark(list, 'a', { mnemonic: '2' });
    assert.match(clash.issues.join(' '), /already used/);
    const bad = updateBookmark(list, 'a', { mnemonic: 'ZZ' });
    assert.ok(bad.issues.length > 0);
    const missing = updateBookmark(list, 'zzz', { label: 'q' });
    assert.match(missing.issues.join(' '), /not found/);
  });
});
