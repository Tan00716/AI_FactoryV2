import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlamePorcelain,
  repoRootOf,
} from '../src/blame';
import { UNCOMMITTED_SHA } from '../src/types';

const FIXTURE = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 1 1 2',
  'author Jane Doe',
  'author-mail <jane@example.com>',
  'author-time 1729500000',
  'author-tz +0800',
  'committer Jane Doe',
  'summary add feature',
  'filename src/a.ts',
  '\tconst x = 1;',
  'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 2 2 2',
  'author Jane Doe',
  'author-mail <jane@example.com>',
  'author-time 1729500000',
  'author-tz +0800',
  'committer Jane Doe',
  'summary add feature',
  'filename src/a.ts',
  '\tconst y = 2;',
  `${UNCOMMITTED_SHA} 3 3 1`,
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 0',
  'summary not yet committed',
  'filename src/a.ts',
  '\tconst z = 3;',
].join('\n');

test('parses porcelain blocks into per-line entries', () => {
  const lines = parseBlamePorcelain(FIXTURE);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].line, 1);
  assert.equal(lines[1].line, 2);
  assert.equal(lines[2].line, 3);
  assert.equal(lines[0].author, 'Jane Doe');
  assert.equal(lines[0].authorMail, 'jane@example.com');
  assert.equal(lines[0].authorTime, 1729500000);
  assert.equal(lines[0].summary, 'add feature');
  assert.equal(lines[0].shortHash, 'a1b2c3d');
  assert.equal(lines[0].uncommitted, false);
});

test('marks all-zero-sha lines as uncommitted', () => {
  const lines = parseBlamePorcelain(FIXTURE);
  const u = lines[2];
  assert.equal(u.uncommitted, true);
  assert.equal(u.hash, UNCOMMITTED_SHA);
  assert.equal(u.author, 'uncommitted');
  assert.equal(u.authorMail, '');
  assert.equal(u.authorTime, 0);
});

test('empty stdout parses to no lines', () => {
  assert.deepEqual(parseBlamePorcelain(''), []);
});

test('handles git\'s collapsed continuation headers (3-field, same commit)', () => {
  // Real git collapses contiguous same-commit lines: the first block is a
  // full 4-field header with metadata, following lines are bare 3-field
  // headers with no metadata.
  const fixture = [
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 1 1 2',
    'author Jane Doe',
    'author-mail <jane@example.com>',
    'author-time 1729500000',
    'summary add feature',
    'filename src/a.ts',
    '\tconst x = 1;',
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 2 2',
    '\tconst y = 2;',
    `${UNCOMMITTED_SHA} 3 3 1`,
    'author Not Committed Yet',
    'summary not yet committed',
    'filename src/a.ts',
    '\tconst z = 3;',
  ].join('\n');
  const lines = parseBlamePorcelain(fixture);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].line, 2);
  assert.equal(lines[1].author, 'Jane Doe'); // metadata reused, not dropped
  assert.equal(lines[1].hash, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(lines[2].uncommitted, true);
});

test('repoRootOf rejects outside a git repo', async () => {
  try {
    await repoRootOf('/tmp/definitely-not-a-repo-r5a4');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal((e as { code?: string }).code, 'NOT_A_REPO');
  }
});

test('repoRootOf resolves inside the real repo', async () => {
  const root = await repoRootOf(process.cwd());
  assert.ok(root.length > 0);
  assert.ok(!root.includes('\n'));
});
