import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTemplate,
  expandSnippet,
  previewSnippet,
  scopeMatches,
  SnippetTemplateError,
} from '../src/template.js';

describe('parseTemplate', () => {
  it('parses plain text', () => {
    assert.deepEqual(parseTemplate('hello'), [{ kind: 'text', text: 'hello' }]);
  });
  it('parses tab stops', () => {
    const segs = parseTemplate('a$1b$0');
    assert.deepEqual(segs, [
      { kind: 'text', text: 'a' },
      { kind: 'tabstop', index: 1 },
      { kind: 'text', text: 'b' },
      { kind: 'tabstop', index: 0 },
    ]);
  });
  it('parses placeholders with defaults', () => {
    const segs = parseTemplate('for (${1:i} of ${2:list})');
    assert.deepEqual(segs[1], { kind: 'placeholder', index: 1, defaultText: 'i' });
    assert.deepEqual(segs[3], { kind: 'placeholder', index: 2, defaultText: 'list' });
  });
  it('parses builtin variables', () => {
    const segs = parseTemplate('${DATE}');
    assert.deepEqual(segs, [{ kind: 'variable', name: 'DATE' }]);
  });
  it('handles \\$ escape', () => {
    const segs = parseTemplate('cost \\$5');
    assert.deepEqual(segs, [{ kind: 'text', text: 'cost $5' }]);
  });
  it('trailing lone $ is literal', () => {
    const segs = parseTemplate('a$');
    assert.deepEqual(segs, [{ kind: 'text', text: 'a$' }]);
  });
  it('$ followed by letter is literal', () => {
    const segs = parseTemplate('$foo');
    assert.deepEqual(segs, [{ kind: 'text', text: '$foo' }]);
  });
  it('rejects unterminated ${', () => {
    assert.throws(() => parseTemplate('a${1'), (e) => e instanceof SnippetTemplateError);
  });
  it('rejects nested placeholders', () => {
    assert.throws(() => parseTemplate('${1:${2:x}}'), /nested/);
  });
  it('rejects unknown ${name} syntax', () => {
    assert.throws(() => parseTemplate('${1x}'), SnippetTemplateError);
  });
});

describe('expandSnippet', () => {
  const def = { id: 'x', trigger: 't', scope: ['*'], body: '' };
  it('substitutes builtin variables, keeps tab stops', () => {
    const r = expandSnippet(
      { ...def, body: 'created ${DATE} by $1$0' },
      { DATE: '2026-10-22' },
    );
    assert.equal(r.text, 'created 2026-10-22 by $1$0');
    assert.deepEqual(r.tabOrder, [1, 0]);
  });
  it('keeps placeholders verbatim', () => {
    const r = expandSnippet({ ...def, body: 'f(${1:a}, ${2:b})' });
    assert.equal(r.text, 'f(${1:a}, ${2:b})');
    assert.deepEqual(r.tabOrder, [1, 2]);
  });
  it('unknown variable expands to empty, never guesses', () => {
    const r = expandSnippet({ ...def, body: 'x${WHATEVER}y' });
    assert.equal(r.text, 'xy');
  });
});

describe('previewSnippet', () => {
  it('replaces placeholders with defaults', () => {
    assert.equal(
      previewSnippet({ id: 'x', trigger: 't', scope: ['*'], body: 'for (${1:i} of ${2:l}) {$0}' }),
      'for (i of l) {}',
    );
  });
});

describe('scopeMatches', () => {
  it('star matches everything, case-insensitive', () => {
    assert.equal(scopeMatches(['*'], 'TypeScript'), true);
    assert.equal(scopeMatches(['python'], 'Python'), true);
    assert.equal(scopeMatches(['python'], 'go'), false);
  });
});
