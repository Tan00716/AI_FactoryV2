import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, isValidEnvKey } from '../src/index.ts';

test('parse: comments, blanks, export, quotes, inline comments', () => {
  const doc = parseDotEnv(
    '# header\n\nPORT=3000\nexport HOST=localhost # main host\nMSG="hello world"\nSINGLE=\'a # b\'\nEMPTY=\n',
  );
  assert.deepEqual(doc.errors, []);
  const byKey = new Map(doc.entries.map((e) => [e.key, e.value]));
  assert.equal(byKey.get('PORT'), '3000');
  assert.equal(byKey.get('HOST'), 'localhost');
  assert.equal(byKey.get('MSG'), 'hello world');
  assert.equal(byKey.get('SINGLE'), 'a # b');
  assert.equal(byKey.get('EMPTY'), '');
  assert.equal(doc.lines.filter((l) => l.kind === 'comment').length, 1);
  assert.equal(doc.lines.filter((l) => l.kind === 'blank').length, 1);
  assert.equal(doc.lines.find((l) => l.key === 'HOST')?.exported, true);
});

test('parse: double-quote escapes and unclosed quote is invalid', () => {
  const doc = parseDotEnv('A="x\\ny"\nB="oops\n');
  assert.equal(doc.entries.find((e) => e.key === 'A')?.value, 'x\ny');
  assert.equal(doc.errors.length, 1);
  assert.equal(doc.errors[0].line, 2);
  assert.equal(doc.lines[1].kind, 'invalid');
});

test('parse: last duplicate wins, occurrences counted, key without = invalid', () => {
  const doc = parseDotEnv('K=one\nK=two\nBARE\n1BAD=x\n');
  const k = doc.entries.find((e) => e.key === 'K');
  assert.equal(k?.value, 'two');
  assert.equal(k?.occurrences, 2);
  assert.equal(doc.errors.length, 2);
});

test('keys: validation', () => {
  assert.equal(isValidEnvKey('FOO_BAR1'), true);
  assert.equal(isValidEnvKey('_x'), true);
  assert.equal(isValidEnvKey('1BAD'), false);
  assert.equal(isValidEnvKey('HAS-DASH'), false);
  assert.equal(isValidEnvKey(''), false);
});
