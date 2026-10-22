/**
 * .code-search format round-trip tests (round-5 task R5-A8). Run:
 *   node --test packages/codesearch/dist/tests/format.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeSearchError,
  grepProject,
  parseCodeSearchFile,
  serializeCodeSearchFile,
} from '../src/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sample(): string {
  const root = mkdtempSync(join(tmpdir(), 'codesearch-fmt-'));
  writeFileSync(join(root, 'x.ts'), 'const needle = 1;\n// needle: found\n');
  return root;
}

test('serialize then parse recovers header and groups', () => {
  const root = sample();
  const result = grepProject(root, { query: 'needle', glob: '*.ts' });
  const doc = serializeCodeSearchFile('.', result, '2026-10-22T00:00:00.000Z');
  assert.ok(doc.startsWith('// === ai-factory code-search v1 ==='));
  const parsed = parseCodeSearchFile(doc);
  assert.equal(parsed.header.query, 'needle');
  assert.equal(parsed.header.regex, false);
  assert.equal(parsed.header.caseSensitive, false);
  assert.deepEqual(parsed.header.globs, ['*.ts']);
  assert.equal(parsed.header.root, '.');
  assert.equal(parsed.header.matches, result.totalMatches);
  assert.deepEqual(
    parsed.groups.map((g) => g.file),
    result.groups.map((g) => g.file),
  );
  assert.deepEqual(
    parsed.groups[0].matches.map((m) => [m.line, m.column]),
    result.groups[0].matches.map((m) => [m.line, m.column]),
  );
});

test('edited header stays parseable for re-run', () => {
  const result = grepProject(sample(), { query: 'needle' });
  const doc = serializeCodeSearchFile('.', result);
  const edited = doc.replace('// query: needle', '// query: other');
  const parsed = parseCodeSearchFile(edited);
  assert.equal(parsed.header.query, 'other');
});

test('corrupt documents fail closed', () => {
  assert.throws(() => parseCodeSearchFile('hello'), CodeSearchError);
  assert.throws(
    () => parseCodeSearchFile('// === ai-factory code-search v1 ===\nno separator here'),
    CodeSearchError,
  );
  const result = grepProject(sample(), { query: 'needle' });
  const doc = serializeCodeSearchFile('.', result);
  const badBool = doc.replace('// regex: false', '// regex: maybe');
  assert.throws(() => parseCodeSearchFile(badBool), CodeSearchError);
  const badBody = doc + '\n??? not a row';
  assert.throws(() => parseCodeSearchFile(badBody), CodeSearchError);
});

test('query containing colon survives the header', () => {
  const result = grepProject(sample(), { query: 'needle: found', regex: true });
  const doc = serializeCodeSearchFile('.', result);
  const parsed = parseCodeSearchFile(doc);
  assert.equal(parsed.header.query, 'needle: found');
});
