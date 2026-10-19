import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols } from '../src/index.js';

describe('extractSymbols (TypeScript/JavaScript)', () => {
  it('finds exported functions, classes, consts, interfaces, types', () => {
    const src = `export function buildIndex(root: string) {}
export class CodeIndexService {}
export const MAX_FILES = 1;
export interface Opts { x: number }
export type Mode = 'a';
function local() {}
const arrow = async () => {};
`;
    const syms = extractSymbols('a.ts', '.ts', src);
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    assert.ok(names.includes('function:buildIndex'));
    assert.ok(names.includes('class:CodeIndexService'));
    assert.ok(names.includes('variable:MAX_FILES'));
    assert.ok(names.includes('interface:Opts'));
    assert.ok(names.includes('type:Mode'));
    assert.ok(names.includes('function:local'));
    assert.ok(names.includes('function:arrow'));
    assert.equal(syms[0].line, 1);
  });

  it('skips comment lines (common false-positive source)', () => {
    const src = `// function notReal() {}
/* class Fake {} */
export function real() {}
`;
    const syms = extractSymbols('a.ts', '.ts', src);
    assert.deepEqual(syms.map((s) => s.name), ['real']);
  });

  it('returns [] for unsupported extensions', () => {
    assert.deepEqual(extractSymbols('a.md', '.md', '# function x()'), []);
  });
});

describe('extractSymbols (Python/Go/Rust)', () => {
  it('python def/class', () => {
    const syms = extractSymbols('a.py', '.py', 'class Foo:\n    def bar(self):\n        pass\nasync def baz():\n');
    assert.deepEqual(syms.map((s) => `${s.kind}:${s.name}`), ['class:Foo', 'function:bar', 'function:baz']);
  });
  it('go func/type', () => {
    const syms = extractSymbols('a.go', '.go', 'func Hello() {}\nfunc (s *Srv) Method() {}\ntype Config struct {}\n');
    assert.ok(syms.some((s) => s.name === 'Hello' && s.kind === 'function'));
    assert.ok(syms.some((s) => s.name === 'Method' && s.kind === 'function'));
    assert.ok(syms.some((s) => s.name === 'Config' && s.kind === 'struct'));
  });
  it('rust fn/struct/enum/trait', () => {
    const syms = extractSymbols('a.rs', '.rs', 'pub fn main() {}\nstruct Point { x: f64 }\npub enum Color {}\ntrait Shape {}\n');
    assert.deepEqual(
      syms.map((s) => `${s.kind}:${s.name}`).sort(),
      ['enum:Color', 'function:main', 'struct:Point', 'trait:Shape'].sort(),
    );
  });
});
