import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTodoLine, parseTodo, serializeTodo, validateTodoAgainstRange } from '../src/todo.js';

test('parseTodo skips comments and blanks, keeps order', () => {
  const lines = parseTodo('# comment\n\npick abcdef0123456789abcdef0123456789abcdef01 first\nreword 1234567 second\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].action, 'pick');
  assert.equal(lines[0].hash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(lines[1].subject, 'second');
});

test('parseTodo rejects exec/label/reset and other git actions', () => {
  assert.throws(() => parseTodo('exec echo hi'), /unsupported todo action/);
  assert.throws(() => parseTodo('label foo'), /unsupported todo action/);
  assert.throws(() => parseTodo('merge -C abcdef0 x'), /unsupported todo action/);
});

test('parseTodo rejects duplicates, malformed hashes, empty todos', () => {
  const h = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.throws(() => parseTodo(`pick ${h} a\npick ${h} b`), /duplicate/);
  assert.throws(() => parseTodo('pick zzz not-a-hash'), /malformed/);
  assert.throws(() => parseTodo('# only a comment\n'), /empty/);
});

test('serializeTodo round-trips parseTodo', () => {
  const text = 'pick aaaaaaa0000000000000000000000000000001 one\nsquash bbbbbbb0000000000000000000000000000002 two\n';
  assert.equal(serializeTodo(parseTodo(text)), text);
});

test('validateTodoAgainstRange requires exact coverage, drop is explicit', () => {
  const range = ['a'.repeat(40), 'b'.repeat(40)];
  const ok = [
    { action: 'pick' as const, hash: 'a'.repeat(40), subject: '' },
    { action: 'drop' as const, hash: 'b'.repeat(40), subject: '' },
  ];
  validateTodoAgainstRange(ok, range);
  assert.throws(
    () => validateTodoAgainstRange([ok[0]], range),
    /missing from todo/,
  );
  assert.throws(
    () =>
      validateTodoAgainstRange(
        [...ok, { action: 'pick' as const, hash: 'c'.repeat(40), subject: '' }],
        range,
      ),
    /not in range/,
  );
});

test('moveTodoLine moves within bounds only', () => {
  const lines = [1, 2, 3].map((n) => ({ action: 'pick' as const, hash: `${n}`.repeat(40).slice(0, 40), subject: `${n}` }));
  const moved = moveTodoLine(lines, 0, 2);
  assert.deepEqual(moved.map((l) => l.subject), ['2', '3', '1']);
  assert.throws(() => moveTodoLine(lines, 0, 3), /out of range/);
});
