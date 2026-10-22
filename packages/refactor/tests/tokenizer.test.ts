import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, offsetToLineCol, lineColToOffset, isValidIdentifier } from '../src/index';

describe('tokenizer', () => {
  it('drops comments and whitespace, tracks line/col', () => {
    const src = 'const x = 1; // hi\n/* multi\nline */ let y = 2;';
    const toks = tokenize(src);
    const vals = toks.map((t) => t.value);
    assert.deepEqual(vals, ['const', 'x', '=', '1', ';', 'let', 'y', '=', '2', ';']);
    const y = toks.find((t) => t.value === 'y');
    assert.ok(y);
    assert.equal(y.line, 3);
  });

  it('handles strings with escapes', () => {
    const toks = tokenize(`const s = "a\\"b"; const t = 'c';`);
    const strs = toks.filter((t) => t.type === 'string').map((t) => t.value);
    assert.deepEqual(strs, [`"a\\"b"`, `'c'`]);
  });

  it('tokenizes template interpolation as nested code', () => {
    const toks = tokenize('const s = `a${x + 1}b`;');
    const opens = toks.filter((t) => t.type === 'brace-open');
    // the `${` is a synthetic brace-open
    assert.equal(opens.length, 1);
    assert.equal(opens[0].value, '${');
    const x = toks.find((t) => t.value === 'x');
    assert.ok(x && x.type === 'identifier');
  });

  it('distinguishes regex from division', () => {
    const toks = tokenize('const r = /ab+c/g; const q = a / b;');
    const regexes = toks.filter((t) => t.type === 'regex');
    assert.equal(regexes.length, 1);
    assert.equal(regexes[0].value, '/ab+c/g');
    const divs = toks.filter((t) => t.value === '/');
    assert.equal(divs.length, 1);
  });

  it('tracks brace and paren depth', () => {
    const toks = tokenize('function f() { if (x) { y(); } }');
    const y = toks.find((t) => t.value === 'y');
    assert.ok(y);
    assert.equal(y.depth, 2);
    assert.equal(y.pdepth, 0);
    const lp = toks.find((t) => t.value === '(');
    assert.ok(lp);
    assert.equal(lp.pdepth, 1);
  });

  it('offset/lineCol roundtrip', () => {
    const src = 'ab\ncde\nf';
    assert.deepEqual(offsetToLineCol(src, 4), { line: 2, col: 2 });
    assert.equal(lineColToOffset(src, 2, 2), 4);
    assert.equal(lineColToOffset(src, 3, 1), 7);
  });

  it('isValidIdentifier', () => {
    assert.equal(isValidIdentifier('foo'), true);
    assert.equal(isValidIdentifier('_a1$'), true);
    assert.equal(isValidIdentifier('1a'), false);
    assert.equal(isValidIdentifier('const'), false);
    assert.equal(isValidIdentifier(''), false);
  });
});
