/**
 * Settings sync package tests (R7-#10).
 * node:test + node:assert/strict, run from compiled dist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  applySections,
  createExport,
  diffSections,
  diffSummary,
  pullRemote,
  pushRemote,
  resolveRemoteToken,
  validateRemoteUrl,
  validateSyncDoc,
} from '../src/index.js';

const GOOD = {
  format: 'ai-factory-settings-sync',
  version: 1,
  exportedAt: '2026-10-30T00:00:00.000Z',
  sections: { keybindings: { items: [] } },
};

test('validateSyncDoc accepts a well-formed document', () => {
  const v = validateSyncDoc(GOOD);
  assert.equal(v.ok, true);
  assert.equal(v.doc?.format, 'ai-factory-settings-sync');
});

test('validateSyncDoc rejects bad format, version, and unknown sections', () => {
  assert.equal(validateSyncDoc({ ...GOOD, format: 'other' }).ok, false);
  assert.equal(validateSyncDoc({ ...GOOD, version: 2 }).ok, false);
  const unknown = validateSyncDoc({ ...GOOD, sections: { secrets: { x: 1 } } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(';'), /unknown section/);
  assert.equal(validateSyncDoc({ ...GOOD, sections: { keybindings: [1, 2] } }).ok, false);
});

test('validateSyncDoc refuses documents matching a secret pattern', () => {
  const hit = validateSyncDoc({
    ...GOOD,
    sections: { 'rules-global': { version: 1, rules: [{ note: 'ghp_' + 'a'.repeat(36) }] } },
  });
  assert.equal(hit.ok, false);
  assert.match(hit.errors.join(';'), /secret pattern/);
});

test('createExport stamps format and version and rejects secrets', () => {
  const doc = createExport({ keybindings: { items: [{ command: 'a', key: 'ctrl+a' }] } }, () => 0);
  assert.equal(doc.format, 'ai-factory-settings-sync');
  assert.equal(doc.version, 1);
  assert.equal(doc.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.throws(
    () => createExport({ 'rules-global': { note: '-----BEGIN PRIVATE KEY-----' } }),
    /secret pattern/,
  );
});

test('diff without a baseline treats differing keys as modified', () => {
  const entries = diffSections(
    { keybindings: { items: [{ command: 'a', key: 'ctrl+a' }] } },
    { keybindings: { items: [] } },
    null,
  );
  assert.deepEqual(entries.map((e) => e.kind), ['modified']);
  assert.deepEqual(diffSummary(entries), { added: 0, modified: 1, conflict: 0, removed: 0 });
});

test('diff with a baseline separates added/modified/conflict/removed', () => {
  const base = { s: { a: 1, b: 2, c: 3, d: 4, e: 5 } };
  const current = { s: { a: 1, b: 2, c: 30, d: 4, e: 50 } };
  const incoming = { s: { a: 1, b: 20, c: 31 } };
  // a: unchanged; b: modified (current==base); c: conflict (both changed);
  // d: removed (current==base, incoming dropped it); e: local-only change
  // vs incoming drop -> conflict.
  const byKey = new Map(diffSections(incoming, current, base).map((e) => [e.key, e.kind]));
  assert.equal(byKey.get('a'), undefined);
  assert.equal(byKey.get('b'), 'modified');
  assert.equal(byKey.get('c'), 'conflict');
  assert.equal(byKey.get('d'), 'removed');
  assert.equal(byKey.get('e'), 'conflict');
});

test('diff: sections absent from the incoming document are untouched', () => {
  const entries = diffSections(
    { a: { x: 1 } },
    { a: { x: 2 }, b: { y: 3 } },
    { a: { x: 0 }, b: { y: 3 } },
  );
  assert.deepEqual(entries.map((e) => `${e.section}:${e.key}`), ['a:x']);
});

test('diff: incoming-only key present in baseline is a conflict; local-only additions are kept silently', () => {
  const base = { s: { gone: 1 } };
  const entries = diffSections({ s: { gone: 2, fresh: 3 } }, { s: { local: 9 } }, base);
  const byKey = new Map(entries.map((e) => [e.key, e.kind]));
  assert.equal(byKey.get('gone'), 'conflict');
  assert.equal(byKey.get('fresh'), 'added');
  assert.equal(byKey.get('local'), undefined);
});

test('apply auto-applies added/modified and refuses unresolved conflicts', () => {
  const base = { s: { b: 2, c: 3 } };
  const current = { s: { b: 2, c: 30 } };
  const incoming = { s: { b: 20, c: 31, n: 1 } };
  assert.throws(() => applySections(incoming, current, base, {}), /unresolved entries: s:c \(conflict\)/);
  const r = applySections(incoming, current, base, { 's:c': 'incoming' });
  assert.deepEqual(r.next, { s: { b: 20, c: 31, n: 1 } });
  assert.deepEqual(r.applied.sort(), ['s:b', 's:c', 's:n']);
  const kept = applySections(incoming, current, base, { 's:c': 'keep' });
  assert.equal(kept.next['s']!['c'], 30);
  assert.deepEqual(kept.kept, ['s:c']);
});

test('apply: removed entries delete only with an incoming resolution', () => {
  const base = { s: { d: 4 } };
  const current = { s: { d: 4 } };
  const incoming = { s: {} };
  assert.throws(() => applySections(incoming, current, base, {}), /unresolved/);
  assert.deepEqual(applySections(incoming, current, base, { 's:d': 'incoming' }).next, { s: {} });
  assert.deepEqual(applySections(incoming, current, base, { 's:d': 'keep' }).next, { s: { d: 4 } });
});

test('validateRemoteUrl rejects credentials and non-http schemes', () => {
  assert.throws(() => validateRemoteUrl('https://user:pass@example.com/x'), /must not embed credentials/);
  assert.throws(() => validateRemoteUrl('ftp://example.com/x'), /must be http/);
  assert.equal(validateRemoteUrl('http://127.0.0.1:9/doc'), 'http://127.0.0.1:9/doc');
});

test('remote push/pull round-trip against a local server, token via env', async () => {
  let stored: string | null = null;
  let seenAuth: string | undefined;
  const srv = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        stored = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end('ok');
      });
    } else if (req.method === 'GET') {
      if (stored === null) {
        res.writeHead(404);
        res.end('none');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(stored);
      }
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/doc`;
  const prev = process.env['FACTORY_SETTINGSYNC_TOKEN'];
  process.env['FACTORY_SETTINGSYNC_TOKEN'] = 'tok-123';
  try {
    assert.equal(resolveRemoteToken(), 'tok-123');
    await assert.rejects(() => pullRemote(url, 'tok-123'), /HTTP 404/);
    const doc = createExport({ keybindings: { items: [] } });
    await pushRemote(url, doc, resolveRemoteToken());
    assert.equal(seenAuth, 'Bearer tok-123');
    const back = await pullRemote(url, resolveRemoteToken());
    assert.equal(back.format, 'ai-factory-settings-sync');
  } finally {
    if (prev === undefined) delete process.env['FACTORY_SETTINGSYNC_TOKEN'];
    else process.env['FACTORY_SETTINGSYNC_TOKEN'] = prev;
    srv.close();
  }
});
