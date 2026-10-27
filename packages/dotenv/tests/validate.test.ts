import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingKeys, parseDotEnv } from '../src/index.ts';

test('missingKeys: required keys absent from the effective set', () => {
  const doc = parseDotEnv('A=1\n');
  assert.deepEqual(missingKeys(doc.entries, ['A', 'B', 'C']), ['B', 'C']);
  assert.deepEqual(missingKeys(doc.entries, []), []);
});
