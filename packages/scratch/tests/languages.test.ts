import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, languageById, languageIds } from '../src/index.ts';

test('registry has 5 languages with unique ids/extensions', () => {
  assert.equal(LANGUAGES.length, 5);
  assert.equal(new Set(languageIds()).size, 5);
  assert.equal(new Set(LANGUAGES.map((l) => l.extension)).size, 5);
});

test('only node-based languages are runnable (exec whitelist honesty)', () => {
  const runnable = LANGUAGES.filter((l) => l.runnable).map((l) => l.id).sort();
  assert.deepEqual(runnable, ['javascript', 'typescript']);
});

test('languageById resolves and returns null for unknown', () => {
  assert.equal(languageById('typescript')?.monacoLanguage, 'typescript');
  assert.equal(languageById('json')?.extension, 'json');
  assert.equal(languageById('cobol'), null);
});
