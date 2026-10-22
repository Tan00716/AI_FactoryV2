import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScopes } from '../src/index';

function declNames(a: ReturnType<typeof analyzeScopes>): string[] {
  return a.declarations.map((d) => `${d.kind}:${d.name}`).sort();
}

describe('scope analysis', () => {
  it('finds function declarations, params and locals', () => {
    const a = analyzeScopes('function f(a, b) { const c = a + b; return c; }');
    assert.ok(declNames(a).includes('function:f'));
    assert.ok(declNames(a).includes('param:a'));
    assert.ok(declNames(a).includes('param:b'));
    assert.ok(declNames(a).includes('const:c'));
  });

  it('resolves shadowing to the inner declaration', () => {
    const src = 'const x = 1;\nfunction f() {\n  const x = 2;\n  return x;\n}\n';
    const a = analyzeScopes(src);
    const retX = a.references.find((r) => r.name === 'x' && r.start > src.indexOf('return'));
    assert.ok(retX && retX.decl);
    assert.equal(src.slice(retX.decl.initStart, retX.decl.initEnd), '2');
  });

  it('handles arrow functions and their params', () => {
    const a = analyzeScopes('const f = (a) => a + 1; const g = b => b;');
    const names = declNames(a);
    assert.ok(names.includes('const:f'));
    assert.ok(names.includes('const:g'));
    assert.ok(names.filter((x) => x === 'param:a').length === 1);
    assert.ok(names.filter((x) => x === 'param:b').length === 1);
  });

  it('handles imports and classes', () => {
    const a = analyzeScopes(`import { readFile } from 'node:fs';\nimport def, * as ns from 'x';\nclass C { m() { return 1; } }`);
    const names = declNames(a);
    assert.ok(names.includes('import:readFile'));
    assert.ok(names.includes('import:def'));
    assert.ok(names.includes('import:ns'));
    assert.ok(names.includes('class:C'));
    assert.ok(names.includes('method:m'));
  });

  it('handles destructuring and for/catch scopes', () => {
    const a = analyzeScopes('const { a, b: c } = o;\nfor (const x of y) { x; }\ntry {} catch (e) { e; }');
    const names = declNames(a);
    assert.ok(names.includes('const:a'));
    assert.ok(names.includes('const:c'));
    assert.ok(names.includes('let:x') || names.includes('const:x'));
    assert.ok(names.includes('catch:e'));
  });

  it('does not treat property access as references', () => {
    const a = analyzeScopes('obj.foo(bar);');
    const names = a.references.map((r) => r.name).sort();
    assert.deepEqual(names, ['bar', 'obj']);
  });

  it('does not treat object keys as references', () => {
    const a = analyzeScopes('const o = { key: value };');
    const names = a.references.map((r) => r.name).sort();
    assert.deepEqual(names, ['value']);
  });

  it('handles ternary without mistaking consequent for a key', () => {
    const a = analyzeScopes('const z = cond ? yes : no;');
    const names = a.references.map((r) => r.name).sort();
    assert.deepEqual(names, ['cond', 'no', 'yes']);
  });

  it('export specifiers resolve to locals', () => {
    const a = analyzeScopes('const a = 1; export { a };');
    const expRefs = a.references.filter((r) => r.name === 'a' && r.decl && r.decl.kind === 'const');
    assert.ok(expRefs.length >= 1);
  });
});
