import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverTests, parseTestFile } from '../src/index';

test('parse: nested describes build fullName chains', () => {
  const cases = parseTestFile([
    "import { test, describe } from 'node:test';",
    "describe('math', () => {",
    "  describe('add', () => {",
    "    test('adds positives', () => {});",
    "  });",
    "  test('top of math', () => {});",
    "});",
    "test('standalone', () => {});",
    '',
  ].join('\n'));
  assert.deepEqual(cases.map((c) => c.fullName), [
    'math > add > adds positives',
    'math > top of math',
    'standalone',
  ]);
  assert.equal(cases[0]?.line, 4);
});

test('parse: .skip/.only suffixes and single-line describes', () => {
  const cases = parseTestFile([
    "describe('one-liner', () => { test('inside', () => {}); });",
    "test.skip('skipped', () => {});",
    "describe.only('focused', () => {",
    "  it('works', () => {});",
    "});",
    '',
  ].join('\n'));
  assert.deepEqual(cases.map((c) => c.fullName), [
    'one-liner > inside',
    'skipped',
    'focused > works',
  ]);
});

test('parse: split-callback describe keeps its body', () => {
  const cases = parseTestFile([
    'describe(',
    "  'split',",
    '  () => {',
    "    test('in split', () => {});",
    '  },',
    ');',
    "test('after', () => {});",
    '',
  ].join('\n'));
  assert.deepEqual(cases.map((c) => c.fullName), ['split > in split', 'after']);
});

test('parse: braces in strings do not mis-nest', () => {
  const cases = parseTestFile([
    "describe('a', () => {",
    "  const s = '} not a close';",
    "  test('still in a', () => {});",
    '});',
    "test('outside', () => {});",
    '',
  ].join('\n'));
  assert.deepEqual(cases.map((c) => c.fullName), ['a > still in a', 'outside']);
});

test('discover: groups by nearest package.json, skips node_modules/dist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tx-disc-'));
  try {
    const pkgDir = path.join(root, 'pkg-a');
    fs.mkdirSync(path.join(pkgDir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@x/pkg-a' }));
    fs.writeFileSync(path.join(pkgDir, 'tests', 'a.test.mjs'), "test('a1', () => {});\n");
    fs.writeFileSync(path.join(root, 'top.test.mjs'), "test('t1', () => {});\n");
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'x.test.mjs'), "test('hidden', () => {});\n");
    fs.writeFileSync(path.join(root, 'dist', 'd.test.mjs'), "test('hidden2', () => {});\n");
    fs.writeFileSync(path.join(root, 'plain.mjs'), "test('not-a-test-file', () => {});\n");
    const d = discoverTests(root);
    assert.equal(d.degraded, false);
    assert.equal(d.totals.files, 2);
    assert.equal(d.totals.cases, 2);
    const names = d.packages.map((p) => p.name).sort();
    assert.deepEqual(names, ['@x/pkg-a', path.basename(root)]);
    const pkgA = d.packages.find((p) => p.name === '@x/pkg-a');
    assert.equal(pkgA?.files[0]?.cases[0]?.fullName, 'a1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discover: oversized files are listed as skipped, caps degrade honestly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tx-cap-'));
  try {
    fs.writeFileSync(path.join(root, 'big.test.mjs'), `test('x', () => {});\n`.padEnd(2000, ' '));
    const d = discoverTests(root, { maxFileBytes: 100 });
    assert.equal(d.totals.files, 1);
    assert.equal(d.totals.cases, 0);
    assert.match(d.packages[0]?.files[0]?.skipped ?? '', /not parsed/);
    const capped = discoverTests(root, { maxTestFiles: 0 });
    assert.equal(capped.degraded, true);
    assert.match(capped.degradedReason ?? '', /test file cap/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
