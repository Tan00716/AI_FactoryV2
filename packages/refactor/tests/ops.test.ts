import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FileEdits,
  RefactorOpResult,
  RefactorWarning,
  applyEdits,
  extractMethod,
  extractVariable,
  inlineVariable,
  renameSymbol,
} from '../src/index';

function mustOk(r: RefactorOpResult): { fileEdits: FileEdits[]; warnings: RefactorWarning[] } {
  if (!r.ok) assert.fail(`expected ok, got error: ${JSON.stringify(r.error)}`);
  return { fileEdits: r.fileEdits, warnings: r.warnings };
}

function mustFail(r: RefactorOpResult): { error: { code: string; message: string } } {
  if (r.ok) assert.fail('expected failure, got ok');
  return { error: r.error };
}

function selOf(src: string, snippet: string, occurrence = 0): { start: number; end: number } {
  let from = 0;
  for (let k = 0; k <= occurrence; k++) {
    const at = src.indexOf(snippet, from);
    assert.ok(at >= 0, `snippet not found: ${snippet}`);
    if (k === occurrence) return { start: at, end: at + snippet.length };
    from = at + 1;
  }
  throw new Error('unreachable');
}

function offOf(src: string, snippet: string, occurrence = 0): number {
  return selOf(src, snippet, occurrence).start;
}

describe('extract-variable', () => {
  it('extracts a simple expression', () => {
    const src = 'function f(a, b) {\n  return a + b * 2;\n}\n';
    const sel = selOf(src, 'a + b * 2');
    const r = extractVariable(src, 'f.ts', sel, 'total');
    const ok = mustOk(r);
    const out = applyEdits(src, ok.fileEdits[0].edits);
    assert.equal(out, 'function f(a, b) {\n  const total = a + b * 2;\n  return total;\n}\n');
  });

  it('replaces all identical occurrences in scope', () => {
    const src = 'function f(a) {\n  const x = a * 2 + a * 2;\n  return a * 2;\n}\n';
    const sel = selOf(src, 'a * 2');
    const r = extractVariable(src, 'f.ts', sel, 'doubled');
    const ok = mustOk(r);
    const out = applyEdits(src, ok.fileEdits[0].edits);
    assert.equal(out, 'function f(a) {\n  const doubled = a * 2;\n  const x = doubled + doubled;\n  return doubled;\n}\n');
  });

  it('skips occurrences where identifiers resolve differently (shadow)', () => {
    const src = [
      'function f(a) {',
      '  const y = a + 1;',
      '  {',
      '    const a = 99;',
      '    const z = a + 1;',
      '  }',
      '  return y;',
      '}',
      '',
    ].join('\n');
    const sel = selOf(src, 'a + 1');
    const r = extractVariable(src, 'f.ts', sel, 'inc');
    const ok = mustOk(r);
    const out = applyEdits(src, ok.fileEdits[0].edits);
    // the shadowed `a + 1` (a === 99) must NOT be replaced
    assert.ok(out.includes('const z = a + 1;'), 'shadowed occurrence kept');
    assert.ok(out.includes('const y = inc;'), 'original replaced');
    assert.ok(ok.warnings.some((w) => w.code === 'shadowed-occurrences'));
  });

  it('warns on side effects', () => {
    const src = 'function f() {\n  return foo() + 1;\n}\n';
    const sel = selOf(src, 'foo()');
    const r = extractVariable(src, 'f.ts', sel, 'v');
    const ok = mustOk(r);
    assert.ok(ok.warnings.some((w) => w.code === 'side-effects'));
  });

  it('rejects name collisions', () => {
    const src = 'function f() {\n  const total = 1;\n  return 2 + 3;\n}\n';
    const sel = selOf(src, '2 + 3');
    const r = extractVariable(src, 'f.ts', sel, 'total');
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'name-collision');
  });

  it('rejects multi-statement selections', () => {
    const src = 'function f() {\n  a(); b();\n}\n';
    const sel = selOf(src, 'a(); b()');
    const r = extractVariable(src, 'f.ts', sel, 'v');
    assert.equal(r.ok, false);
  });
});

describe('extract-method', () => {
  it('extracts statements into a function (closure capture, no params)', () => {
    const src = [
      'function f(items) {',
      '  let total = 0;',
      '  for (const it of items) {',
      '    total += it.price * it.qty;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n');
    const r = extractMethod(src, 'f.ts', { startLine: 3, endLine: 5 }, 'sumItems');
    assert.equal(r.ok, true, !r.ok ? JSON.stringify(r.error) : '');
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('function sumItems() {'), 'function created');
    assert.ok(out.includes('total = sumItems();'), 'call site assigns');
    assert.ok(out.includes('return total;'), 'assigned var returned');
    // closure: items/it captured, no params synthesized
    assert.ok(!out.includes('function sumItems(items'), 'no params');
  });

  it('extracts without return when nothing is assigned', () => {
    const src = 'function f() {\n  console.log(1);\n  console.log(2);\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 2, endLine: 3 }, 'logBoth');
        assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('logBoth();'));
    assert.ok(!out.includes('return;'));
  });

  it('returns an object when multiple outer vars are assigned', () => {
    const src = 'function f() {\n  let a = 0;\n  let b = 0;\n  a = 1;\n  b = 2;\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 4, endLine: 5 }, 'init');
    assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('return { a, b };'));
    assert.ok(out.includes('({ a, b } = init());'));
  });

  it('refuses escaping return', () => {
    const src = 'function f(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 2, endLine: 4 }, 'check');
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'control-flow');
  });

  it('refuses when a declared name leaks past the selection', () => {
    const src = 'function f() {\n  const z = 1;\n  console.log(z);\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 2, endLine: 2 }, 'make');
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'leak');
  });

  it('marks async when selection awaits', () => {
    const src = 'async function f() {\n  const x = 1;\n  const a = await g();\n  console.log(a + x);\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 3, endLine: 4 }, 'load');
    assert.equal(r.ok, true, !r.ok ? JSON.stringify(r.error) : '');
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('async function load()'));
    assert.ok(out.includes('await load()'));
  });

  it('warns on this usage', () => {
    const src = 'class C {\n  m() {\n    console.log(this.x);\n  }\n}\n';
    const r = extractMethod(src, 'f.ts', { startLine: 3, endLine: 3 }, 'show');
    assert.equal(r.ok, true);
    assert.ok(mustOk(r).warnings.some((w) => w.code === 'this-context'));
  });
});

describe('inline-variable', () => {
  it('inlines a simple const', () => {
    const src = 'function f(a) {\n  const b = a * 2;\n  return b + b;\n}\n';
    const r = inlineVariable(src, 'f.ts', offOf(src, 'b ='));
        assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.equal(out, 'function f(a) {\n  return (a * 2) + (a * 2);\n}\n');
  });

  it('does not parenthesize atomic inits', () => {
    const src = 'function f() {\n  const b = 42;\n  return b;\n}\n';
    const r = inlineVariable(src, 'f.ts', offOf(src, 'b ='));
    assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('return 42;'));
  });

  it('refuses reassigned variables', () => {
    const src = 'function f() {\n  let b = 1;\n  b = 2;\n  return b;\n}\n';
    const r = inlineVariable(src, 'f.ts', offOf(src, 'b ='));
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'reassigned');
  });

  it('refuses multi-declarator statements', () => {
    const src = 'function f() {\n  const a = 1, b = 2;\n  return a;\n}\n';
    const r = inlineVariable(src, 'f.ts', offOf(src, 'a ='));
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'multi-declarator');
  });

  it('refuses use-before-declaration (var hoisting)', () => {
    const src = 'function f() {\n  console.log(v);\n  var v = 1;\n}\n';
    const r = inlineVariable(src, 'f.ts', offOf(src, 'v ='));
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'use-before-decl');
  });
});

describe('rename-symbol', () => {
  it('renames declaration and all bound references', () => {
    const src = 'const count = 0;\nfunction inc() {\n  return count + 1;\n}\n';
    const r = renameSymbol(src, 'f.ts', offOf(src, 'count ='), 'total');
        assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.equal(out, 'const total = 0;\nfunction inc() {\n  return total + 1;\n}\n');
  });

  it('does not rename shadowed inner declarations', () => {
    const src = [
      'const x = 1;',
      'function f() {',
      '  const x = 2;',
      '  return x + 1;',
      '}',
      'console.log(x);',
      '',
    ].join('\n');
    const r = renameSymbol(src, 'f.ts', offOf(src, 'x = 1'), 'outer');
    assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('const outer = 1;'));
    assert.ok(out.includes('const x = 2;'), 'inner shadow kept');
    assert.ok(out.includes('console.log(outer);'));
  });

  it('does not touch property accesses', () => {
    const src = 'const x = 1;\nconsole.log(obj.x);\n';
    const r = renameSymbol(src, 'f.ts', offOf(src, 'x = 1'), 'y');
    assert.equal(r.ok, true);
    const out = applyEdits(src, mustOk(r).fileEdits[0].edits);
    assert.ok(out.includes('obj.x'), 'property kept');
    assert.ok(out.includes('const y = 1;'));
  });

  it('renames across files via imports', () => {
    const aSrc = 'export function helper() {\n  return 1;\n}\n';
    const bSrc = `import { helper } from './a';\nconst v = helper();\n`;
    const r = renameSymbol(aSrc, 'a.ts', offOf(aSrc, 'helper('), 'util', [
      { path: 'b.ts', source: bSrc },
    ]);
    assert.equal(r.ok, true, !r.ok ? JSON.stringify(r.error) : '');
    const files = mustOk(r).fileEdits;
    assert.equal(files.length, 2);
    const bEdit = files.find((f) => f.file === 'b.ts');
    assert.ok(bEdit);
    const bOut = applyEdits(bSrc, bEdit.edits);
    assert.ok(bOut.includes(`import { util } from './a';`), `got: ${bOut}`);
    assert.ok(bOut.includes('const v = util();'));
  });

  it('keeps import aliases stable', () => {
    const aSrc = 'export const helper = 1;\n';
    const bSrc = `import { helper as h } from './a';\nconsole.log(h);\n`;
    const r = renameSymbol(aSrc, 'a.ts', offOf(aSrc, 'helper ='), 'util', [
      { path: 'b.ts', source: bSrc },
    ]);
    assert.equal(r.ok, true);
    const bEdit = mustOk(r).fileEdits.find((f) => f.file === 'b.ts');
    assert.ok(bEdit);
    const bOut = applyEdits(bSrc, bEdit.edits);
    assert.ok(bOut.includes(`import { util as h } from './a';`), `got: ${bOut}`);
    assert.ok(bOut.includes('console.log(h);'), 'alias uses untouched');
  });

  it('rejects collisions', () => {
    const src = 'const a = 1;\nconst b = 2;\nconsole.log(a);\n';
    const r = renameSymbol(src, 'f.ts', offOf(src, 'a ='), 'b');
    assert.equal(r.ok, false);
    assert.equal(mustFail(r).error.code, 'name-collision');
  });
});

describe('applyEdits', () => {
  it('applies multiple edits deterministically', () => {
    const out = applyEdits('abcdef', [
      { start: 0, end: 1, text: 'A' },
      { start: 4, end: 6, text: 'EF' },
    ]);
    assert.equal(out, 'AbcdEF');
  });

  it('throws on overlap', () => {
    assert.throws(() => applyEdits('abcdef', [
      { start: 0, end: 3, text: 'x' },
      { start: 2, end: 5, text: 'y' },
    ]));
  });
});
