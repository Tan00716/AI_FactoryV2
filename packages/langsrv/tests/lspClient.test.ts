import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { LspClient, LangSrvError } from '../src/index.js';

const fakeServer = path.join(__dirname, 'fixtures', 'fake-lsp-server.mjs');

test('LSP client: initialize + definition/references/hover/outline against a fake server', async () => {
  const client = new LspClient({ command: process.execPath, args: [fakeServer] });
  try {
    await client.start('/repo');
    const defs = await client.definition('/repo', 'b.ts', 2, 10);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].file, 'a.ts');
    assert.equal(defs[0].line, 0);
    const refs = await client.references('/repo', 'b.ts', 2, 10);
    assert.equal(refs.length, 2);
    const hover = await client.hover('/repo', 'b.ts', 2, 10);
    assert.ok(hover !== null);
    assert.match(hover.display, /greet/);
    const outline = await client.outline('/repo', 'a.ts');
    assert.equal(outline.length, 1);
    assert.equal(outline[0].name, 'greet');
  } finally {
    await client.dispose();
  }
});

test('LSP client: unspawnable command fails as LSP_UNAVAILABLE', async () => {
  const client = new LspClient({ command: 'definitely-not-a-real-binary-xyz-123' });
  await assert.rejects(
    client.start('/repo'),
    (err: unknown) => err instanceof LangSrvError && err.code === 'LSP_UNAVAILABLE',
  );
  await client.dispose();
});
