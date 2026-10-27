import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../src/index.js';
import { previewDataFile, parseDataFile } from '../src/index.js';

test('jsonl: basic rows, column union, late keys padded', () => {
  const p = parseJsonl('{"a":1,"b":"x"}\n{"a":2,"c":true}\n');
  assert.deepEqual(p.columns, ['a', 'b', 'c']);
  assert.deepEqual(p.rows, [
    ['1', 'x', null],
    ['2', null, 'true'],
  ]);
  assert.equal(p.malformedRows, 0);
  assert.equal(p.truncated, false);
});

test('jsonl: blank lines skipped, malformed counted, non-objects rejected', () => {
  const p = parseJsonl('\n{"a":1}\nnot json\n[1,2]\n{"a":2}\n42\n');
  assert.equal(p.rows.length, 2);
  assert.equal(p.malformedRows, 3);
});

test('jsonl: nested values render as compact JSON, null stays null', () => {
  const p = parseJsonl('{"a":{"x":1},"b":null,"c":[1,2]}\n');
  assert.deepEqual(p.rows, [['{"x":1}', null, '[1,2]']]);
});

test('jsonl: row cap truncates at 100000', () => {
  const lines = Array.from({ length: 100_002 }, (_, i) => `{"n":${i}}`).join('\n');
  const p = parseJsonl(lines);
  assert.equal(p.rows.length, 100_000);
  assert.equal(p.truncated, true);
});

test('jsonl: sort numeric-aware, filter substring, paginate', () => {
  const text = '{"name":"b","n":10}\n{"name":"a","n":2}\n{"name":"c","n":30}\n';
  const v = previewDataFile(text, 'jsonl', { sortColumn: 'n', sortDir: 'asc', page: 2, pageSize: 2 });
  assert.equal(v.totalRows, 3);
  assert.equal(v.totalPages, 2);
  assert.deepEqual(v.rows, [['c', '30']]);
  const f = previewDataFile(text, 'jsonl', { filter: 'A' });
  assert.equal(f.filteredRows, 1);
  assert.deepEqual(f.rows, [['a', '2']]);
});

test('jsonl: unknown sort column leaves order unchanged', () => {
  const v = previewDataFile('{"a":2}\n{"a":1}\n', 'jsonl', { sortColumn: 'nope' });
  assert.deepEqual(v.rows, [['2'], ['1']]);
});

test('parseDataFile rejects unknown format', () => {
  assert.throws(() => parseDataFile('x', 'xml' as never), /unsupported/);
});
