import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchFile, validateRule } from '../src/rules';

const good = {
  id: 'lint-on-save',
  name: 'Lint on save',
  globs: ['src/**/*.ts'],
  action: { type: 'task', label: 'lint' },
  debounceMs: 500,
  enabled: true,
};

test('valid rule passes, debounce clamped', () => {
  const v = validateRule({ ...good, debounceMs: 5 });
  assert.equal(v.errors.length, 0);
  assert.equal(v.rule?.debounceMs, 100);
  const v2 = validateRule({ ...good, debounceMs: 999999 });
  assert.equal(v2.rule?.debounceMs, 60000);
  const v3 = validateRule({ ...good, debounceMs: undefined });
  assert.equal(v3.rule?.debounceMs, 500);
});

test('invalid rules fail closed with reasons', () => {
  assert.equal(validateRule({ ...good, globs: [] }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, globs: ['/abs/*.ts'] }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, globs: ['../x.ts'] }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, action: { type: 'recipe', label: 'x' } }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, action: { type: 'task', label: '' } }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, id: 'bad id!' }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, name: '' }).errors.length > 0, true);
  assert.equal(validateRule({ ...good, globs: Array(21).fill('*.ts') }).errors.length > 0, true);
});

test('parseWatchFile rejects bad JSON and duplicate ids', () => {
  assert.equal(parseWatchFile('{oops').errors.length, 1);
  const dup = parseWatchFile(JSON.stringify({ version: 1, rules: [good, good] }));
  assert.equal(dup.rules.length, 1);
  assert.equal(dup.errors.length, 1);
  const ok = parseWatchFile(JSON.stringify({ version: 1, rules: [good] }));
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.rules.length, 1);
});
