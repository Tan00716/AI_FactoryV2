import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createScratch,
  deleteScratch,
  getScratch,
  listScratches,
  updateScratch,
  _fileNameForTest,
  MAX_CONTENT_BYTES,
  MAX_SCRATCHES,
  ScratchError,
} from '../src/index.ts';

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'scratch-store-test-'));
}

const ID = '12345678-1234-1234-1234-123456789abc';

test('create/list/get round-trip with language extension', () => {
  const root = freshRoot();
  const meta = createScratch(root, { id: ID, name: 'try one', language: 'typescript' });
  assert.equal(meta.language, 'typescript');
  assert.equal(_fileNameForTest(meta), `${ID}.ts`);
  assert.deepEqual(listScratches(root).map((m) => m.id), [ID]);
  const full = getScratch(root, ID);
  assert.equal(full.content, '');
});

test('create rejects bad id, bad name, bad language', () => {
  const root = freshRoot();
  assert.throws(() => createScratch(root, { id: '../evil', name: 'x', language: 'typescript' }), ScratchError);
  assert.throws(() => createScratch(root, { id: ID, name: '', language: 'typescript' }), ScratchError);
  assert.throws(() => createScratch(root, { id: ID, name: 'x', language: 'cobol' }), ScratchError);
});

test('update content persists and tracks size; oversize refused', () => {
  const root = freshRoot();
  createScratch(root, { id: ID, name: 'x', language: 'javascript' });
  const meta = updateScratch(root, ID, { content: 'console.log(1)\n' });
  assert.ok(meta.sizeBytes > 0);
  assert.equal(getScratch(root, ID).content, 'console.log(1)\n');
  assert.throws(
    () => updateScratch(root, ID, { content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }),
    (e: unknown) => (e as ScratchError).code === 'too-large',
  );
});

test('rename validates; unknown id throws not-found', () => {
  const root = freshRoot();
  createScratch(root, { id: ID, name: 'old', language: 'json' });
  const meta = updateScratch(root, ID, { name: 'new name' });
  assert.equal(meta.name, 'new name');
  assert.throws(
    () => updateScratch(root, 'deadbeef-dead-dead-dead-deadbeefdead', { name: 'z' }),
    (e: unknown) => (e as ScratchError).code === 'not-found',
  );
});

test('delete removes file and index entry; double delete is not-found', () => {
  const root = freshRoot();
  createScratch(root, { id: ID, name: 'x', language: 'markdown' });
  deleteScratch(root, ID);
  assert.deepEqual(listScratches(root), []);
  assert.throws(() => deleteScratch(root, ID), (e: unknown) => (e as ScratchError).code === 'not-found');
});

test('scratch limit is enforced', () => {
  const root = freshRoot();
  for (let i = 0; i < MAX_SCRATCHES; i++) {
    const id = `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    createScratch(root, { id, name: `s${i}`, language: 'plaintext' });
  }
  assert.throws(
    () => createScratch(root, { id: '99999999-9999-9999-9999-999999999999', name: 'overflow', language: 'plaintext' }),
    (e: unknown) => (e as ScratchError).code === 'too-many',
  );
});
