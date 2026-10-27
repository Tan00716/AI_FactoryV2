import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvOps, parseDotEnv, quoteEnvValue } from '../src/index.ts';

const SAMPLE = '# header\n\nPORT=3000 # web\nHOST=localhost\n';

test('roundtrip: untouched text is byte-identical', () => {
  assert.equal(applyEnvOps(SAMPLE, []), SAMPLE);
  assert.equal(parseDotEnv(applyEnvOps(SAMPLE, [])).entries.length, 2);
});

test('set: rewrites first occurrence, collapses duplicates, keeps comments', () => {
  const out = applyEnvOps('# c\nK=one\nK=two\n', [{ type: 'set', key: 'K', value: 'three' }]);
  assert.equal(out, '# c\nK=three\n');
});

test('set: appends absent keys, quotes values that need it', () => {
  const out = applyEnvOps('A=1\n', [
    { type: 'set', key: 'B', value: 'hello world' },
    { type: 'set', key: 'C', value: 'a#b' },
  ]);
  assert.equal(out, 'A=1\nB="hello world"\nC="a#b"\n');
  assert.equal(parseDotEnv(out).entries.find((e) => e.key === 'B')?.value, 'hello world');
});

test('delete: drops all lines for the key, keeps the rest', () => {
  const out = applyEnvOps('A=1\n# keep\nB=2\n', [{ type: 'delete', key: 'A' }]);
  assert.equal(out, '# keep\nB=2\n');
});

test('set: keeps export prefix, empty value stays bare', () => {
  const out = applyEnvOps('export A=1\n', [{ type: 'set', key: 'A', value: '' }]);
  assert.equal(out, 'export A=\n');
});

test('quote: bare values pass through, multiline values escape', () => {
  assert.equal(quoteEnvValue('abc-123'), 'abc-123');
  assert.equal(quoteEnvValue('a b'), '"a b"');
  assert.equal(quoteEnvValue('line1\nline2'), '"line1\\nline2"');
  assert.equal(parseDotEnv(`K=${quoteEnvValue('line1\nline2')}\n`).entries[0].value, 'line1\nline2');
});
