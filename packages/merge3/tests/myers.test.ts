/**
 * Myers diff tests: opcode validity by reconstruction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, type Opcode } from '../src/index.js';

function checkRoundtrip(a: string[], b: string[]): void {
  const opcodes = diffLines(a, b);
  // coverage: a-ranges tile [0, a.length), b-ranges tile [0, b.length)
  let ai = 0;
  let bi = 0;
  for (const oc of opcodes) {
    assert.equal(oc.aStart, ai, 'a gap/overlap');
    assert.equal(oc.bStart, bi, 'b gap/overlap');
    ai = oc.aEnd;
    bi = oc.bEnd;
  }
  assert.equal(ai, a.length);
  assert.equal(bi, b.length);
  // reconstruct b from opcodes
  const out: string[] = [];
  for (const oc of opcodes) {
    if (oc.tag === 'equal') for (let i = oc.aStart; i < oc.aEnd; i += 1) out.push(a[i]);
    else if (oc.tag === 'insert' || oc.tag === 'replace')
      for (let i = oc.bStart; i < oc.bEnd; i += 1) out.push(b[i]);
    // delete: skip a-lines
  }
  assert.deepEqual(out, b);
}

test('empty inputs', () => {
  assert.deepEqual(diffLines([], []), []);
});

test('pure insert', () => {
  const oc = diffLines([], ['x', 'y']);
  assert.equal(oc.length, 1);
  assert.equal(oc[0].tag, 'insert');
});

test('pure delete', () => {
  const oc = diffLines(['x'], []);
  assert.equal(oc.length, 1);
  assert.equal(oc[0].tag, 'delete');
});

test('single replace', () => {
  const oc = diffLines(['a'], ['b']);
  checkRoundtrip(['a'], ['b']);
  assert.equal(oc.length, 1);
  assert.equal(oc[0].tag, 'replace');
});

test('classic example roundtrips', () => {
  checkRoundtrip('ABCABBA'.split(''), 'CBABAC'.split(''));
});

test('identical arrays -> single equal', () => {
  const oc = diffLines(['a', 'b'], ['a', 'b']);
  assert.equal(oc.length, 1);
  assert.equal(oc[0].tag, 'equal');
});

test('fuzz: random small arrays always reconstruct', () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ['a', 'b', 'c', 'd'];
  for (let t = 0; t < 200; t += 1) {
    const n = Math.floor(rnd() * 12);
    const m = Math.floor(rnd() * 12);
    const a = Array.from({ length: n }, () => alphabet[Math.floor(rnd() * 4)]);
    const b = Array.from({ length: m }, () => alphabet[Math.floor(rnd() * 4)]);
    checkRoundtrip(a, b);
  }
});

test('diff is minimal on simple case', () => {
  // one substitution: exactly one replace opcode
  const oc = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.equal(oc.length, 3);
  assert.equal(oc[1].tag, 'replace');
});
