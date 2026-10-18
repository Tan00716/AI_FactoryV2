/**
 * Attachment store tests (W-E).
 *
 * Pure store-level tests against a temp AI_FACTORY_DATA_DIR:
 *   save/list/read round-trip · mime whitelist · 10MiB cap ·
 *   task-id allowlist · path jail · filename sanitization · sha256.
 *
 * Run: npm run test:server (TMPDIR wrapper; the store imports node
 * builtins only, so the .ts-suffix src import is safe per the
 * dual-mode rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ATTACHMENT_MIME_ALLOW,
  MAX_ATTACHMENT_BYTES,
  attachmentFilePath,
  listTaskAttachments,
  readTaskAttachment,
  sanitizeFilename,
  saveTaskAttachment,
} from '../src/attachment-store.ts';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let tmpRoot: string;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-attachments-'));
  process.env.AI_FACTORY_DATA_DIR = path.join(tmpRoot, 'data');
});
test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AI_FACTORY_DATA_DIR;
});

test('save/list/read round-trip', () => {
  const taskId = 'task-abc_123';
  const rec = saveTaskAttachment(taskId, {
    filename: 'screenshot.png',
    mimeType: 'image/png',
    dataBase64: PNG_B64,
  });
  assert.match(rec.id, /^[0-9a-f]{16}-screenshot\.png$/);
  assert.equal(rec.mimeType, 'image/png');
  assert.ok(rec.size > 0);
  assert.equal(rec.sha256.length, 64);

  const list = listTaskAttachments(taskId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, rec.id);

  const found = readTaskAttachment(taskId, rec.id);
  assert.ok(found);
  assert.equal(found.record.sha256, rec.sha256);
  assert.ok(found.bytes.length > 0);
});

test('data URL prefix is tolerated', () => {
  const rec = saveTaskAttachment('task-dataurl', {
    filename: 'a.png',
    mimeType: 'image/png',
    dataBase64: `data:image/png;base64,${PNG_B64}`,
  });
  assert.ok(rec.size > 0);
});

test('mime whitelist rejects non-images', () => {
  assert.throws(
    () =>
      saveTaskAttachment('task-badmime', {
        filename: 'evil.exe',
        mimeType: 'application/x-msdownload',
        dataBase64: PNG_B64,
      }),
    /unsupported mime type/,
  );
  assert.ok(ATTACHMENT_MIME_ALLOW.has('image/png'));
});

test('oversize images are rejected', () => {
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7).toString('base64');
  assert.throws(
    () =>
      saveTaskAttachment('task-big', {
        filename: 'big.png',
        mimeType: 'image/png',
        dataBase64: big,
      }),
    /exceeds/,
  );
});

test('task id allowlist blocks traversal', () => {
  for (const bad of ['../evil', 'a/b', '', 'x'.repeat(65)]) {
    assert.throws(() => listTaskAttachments(bad), /invalid task id/);
    assert.throws(
      () =>
        saveTaskAttachment(bad, { filename: 'a.png', mimeType: 'image/png', dataBase64: PNG_B64 }),
      /invalid task id/,
    );
  }
});

test('attachment path is jailed inside the task directory', () => {
  assert.throws(() => attachmentFilePath('task-1', '../../etc/passwd'), /invalid attachment id/);
  assert.throws(() => attachmentFilePath('task-1', 'not-an-id'), /invalid attachment id/);
  const p = attachmentFilePath('task-1', 'abcdef0123456789-shot.png');
  assert.ok(p.includes(path.join('attachments', 'task-1')));
});

test('filenames are sanitized (no directories, bounded)', () => {
  assert.equal(sanitizeFilename('../../etc/passwd', 'image/png'), 'passwd.png');
  assert.equal(sanitizeFilename('a'.repeat(200), 'image/jpeg').length <= 84, true);
  assert.equal(sanitizeFilename('', 'image/webp'), 'image.webp');
});

test('unknown task lists empty; unknown attachment reads null', () => {
  assert.deepEqual(listTaskAttachments('task-nothing-here'), []);
  assert.equal(readTaskAttachment('task-nothing-here', 'abcdef0123456789-x.png'), null);
});
