/**
 * Tests for the 7 text-level mutation operators.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATORS, applyMutant, generateMutants, operatorByName, segmentSource } from '../src/index';

describe('segmentSource', () => {
  it('marks strings and comments as non-code', () => {
    const segs = segmentSource(`const a = 1; // a + b\nconst s = 'x+y'; /* z-w */\nconst t = \`v\${1+2}w\`;`);
    const code = segs
      .filter((s) => s.code)
      .map((s) => s.text)
      .join('');
    assert.ok(!code.includes('a + b'), 'line comment excluded');
    assert.ok(!code.includes('x+y'), 'string excluded');
    assert.ok(!code.includes('z-w'), 'block comment excluded');
    assert.ok(!code.includes('1+2'), 'template interpolation excluded (v1 boundary)');
    assert.ok(code.includes('const a = 1;'));
  });

  it('handles escaped quotes inside strings', () => {
    const segs = segmentSource(`const s = 'it\\'s + ok';\nconst x = a+b;`);
    const code = segs
      .filter((s) => s.code)
      .map((s) => s.text)
      .join('');
    assert.ok(!code.includes("it's + ok"));
    assert.ok(code.includes('a+b'));
  });
});

describe('operators', () => {
  it('exposes exactly 7 operators', () => {
    assert.equal(OPERATORS.length, 7);
    const names = OPERATORS.map((o) => o.name).sort();
    assert.deepEqual(names, [
      'arithmetic-minus',
      'arithmetic-plus',
      'boolean-literal',
      'equality',
      'inequality',
      'logical-operator',
      'relational-boundary',
    ]);
  });

  it('operatorByName resolves', () => {
    assert.equal(operatorByName('equality')?.title, 'Equality: === → !==');
    assert.equal(operatorByName('nope'), undefined);
  });

  it('arithmetic-plus: + → - but not ++ / += / e+', () => {
    const sites = operatorByName('arithmetic-plus')!.find('a + b; c++; d += e; 1e+10;');
    assert.equal(sites.length, 1);
    assert.equal(sites[0].replacement, '-');
    assert.equal(sites[0].description, '`+` → `-`');
  });

  it('arithmetic-minus: - → + but not -- / -= / e-', () => {
    const sites = operatorByName('arithmetic-minus')!.find('a - b; c--; d -= e; 1e-3; -x;');
    // 'a - b' and unary '-x' mutate; '--', '-=', 'e-' do not
    assert.equal(sites.length, 2);
    assert.ok(sites.every((s) => s.replacement === '+'));
  });

  it('equality / inequality flip', () => {
    assert.deepEqual(
      operatorByName('equality')!.find('a === b').map((s) => s.replacement),
      ['!=='],
    );
    assert.deepEqual(
      operatorByName('inequality')!.find('a !== b').map((s) => s.replacement),
      ['==='],
    );
  });

  it('relational-boundary shifts each direction', () => {
    const op = operatorByName('relational-boundary')!;
    const pairs = op.find('a < b; c > d; e <= f; g >= h;');
    assert.deepEqual(
      pairs.map((s) => s.replacement),
      ['<=', '>=', '<', '>'],
    );
  });

  it('relational-boundary skips => and >>', () => {
    const op = operatorByName('relational-boundary')!;
    assert.equal(op.find('(x) => x; a >> b;').length, 0);
  });

  it('boolean-literal flips true/false', () => {
    const sites = operatorByName('boolean-literal')!.find('return true; x = false;');
    assert.deepEqual(
      sites.map((s) => s.replacement),
      ['false', 'true'],
    );
  });

  it('logical-operator flips && / ||', () => {
    const sites = operatorByName('logical-operator')!.find('a && b || c;');
    assert.deepEqual(
      sites.map((s) => s.replacement),
      ['||', '&&'],
    );
  });
});

describe('generateMutants', () => {
  const SRC = `export function add(a: number, b: number): number {\n  return a + b; // sum\n}\nconst s = 'not + mutated';\n`;

  it('generates mutants only in code, with stable ids and line/col', () => {
    const mutants = generateMutants(SRC, 'calc.ts');
    assert.equal(mutants.length, 1);
    const m = mutants[0];
    assert.equal(m.id, 'calc.ts:2:12:arithmetic-plus');
    assert.equal(m.operator, 'arithmetic-plus');
    assert.equal(m.original, '+');
    assert.equal(m.replacement, '-');
    assert.equal(m.line, 2);
    assert.equal(m.column, 12);
  });

  it('is deterministic across calls', () => {
    const a = generateMutants(SRC, 'calc.ts').map((m) => m.id);
    const b = generateMutants(SRC, 'calc.ts').map((m) => m.id);
    assert.deepEqual(a, b);
  });

  it('applyMutant splices the replacement', () => {
    const mutants = generateMutants(SRC, 'calc.ts');
    const out = applyMutant(SRC, mutants[0]);
    assert.ok(out.includes('return a - b;'));
    assert.ok(out.includes("'not + mutated'"), 'string untouched');
  });

  it('counts mutants on the calc fixture (sanity)', () => {
    const src = `export function add(a: number, b: number): number {
  return a + b;
}
export function isPositive(n: number): boolean {
  return n > 0;
}`;
    const mutants = generateMutants(src, 'calc.ts');
    const byOp = new Map<string, number>();
    for (const m of mutants) byOp.set(m.operator, (byOp.get(m.operator) ?? 0) + 1);
    assert.equal(byOp.get('arithmetic-plus'), 1);
    assert.equal(byOp.get('relational-boundary'), 1);
  });
});
