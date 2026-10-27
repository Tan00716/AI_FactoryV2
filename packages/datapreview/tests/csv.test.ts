import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/index.js';
import { previewDataFile } from '../src/index.js';

test('csv: header + rows, ragged rows padded', () => {
  const p = parseCsv('a,b,c\n1,2\n3,4,5,6\n');
  assert.deepEqual(p.columns, ['a', 'b', 'c']);
  assert.deepEqual(p.rows, [
    ['1', '2', null],
    ['3', '4', '5'],
  ]);
  assert.equal(p.malformedRows, 0);
});

test('csv: quoted fields, doubled quotes, embedded comma and newline', () => {
  const p = parseCsv('name,note\n"Doe, Jane","says ""hi"""\n"multi","line1\nline2"\n');
  assert.deepEqual(p.rows, [
    ['Doe, Jane', 'says "hi"'],
    ['multi', 'line1\nline2'],
  ]);
});

test('csv: CRLF line endings', () => {
  const p = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(p.rows, [['1', '2'], ['3', '4']]);
});

test('csv: empty and duplicate headers get stable names', () => {
  const p = parseCsv(',x,x\n1,2,3\n');
  assert.deepEqual(p.columns, ['column_1', 'x', 'x_2']);
});

test('csv: unterminated quote is malformed and skipped, not guessed', () => {
  const p = parseCsv('a,b\n1,"oops\n');
  assert.equal(p.rows.length, 0);
  assert.equal(p.malformedRows, 1);
});

test('csv: blank lines skipped silently', () => {
  const p = parseCsv('a\n\n1\n\n2\n');
  assert.deepEqual(p.rows, [['1'], ['2']]);
  assert.equal(p.malformedRows, 0);
});

test('csv: sort and filter through the view', () => {
  const v = previewDataFile('name,n\nb,10\na,2\n', 'csv', { sortColumn: 'n', sortDir: 'desc' });
  assert.deepEqual(v.rows, [['b', '10'], ['a', '2']]);
  const f = previewDataFile('name,n\nb,10\na,2\n', 'csv', { filter: 'b' });
  assert.equal(f.filteredRows, 1);
});

test('csv: header-only file yields zero rows', () => {
  const p = parseCsv('a,b,c\n');
  assert.deepEqual(p.columns, ['a', 'b', 'c']);
  assert.equal(p.rows.length, 0);
});
