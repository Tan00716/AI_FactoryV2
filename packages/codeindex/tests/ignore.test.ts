/**
 * Ignore-gate integration tests for @ai-factory/codeindex (task ②):
 * the walk prunes ignored paths, buildIndex drops now-ignored records
 * from a previous index, and the service's query-time post-filter keeps
 * a stale index from leaking a file ignored after it was indexed.
 *
 * Run (after build): node --test packages/codeindex/dist/tests/ignore.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, CodeIndexService, walkRepo } from '../src/index.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cidx-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/main.ts'), 'export function helloMain(): number { return 1; }\n');
  writeFileSync(join(dir, 'secret.ts'), 'export function topSecretFn(): number { return 42; }\n');
  writeFileSync(join(dir, 'notes.txt'), 'the needleword hides here\n');
  return dir;
}

/** Predicate hiding secret.ts + notes.txt (as the gate would). */
function ignoreSecret(abs: string): boolean {
  return abs.endsWith('secret.ts') || abs.endsWith('notes.txt');
}

test('walkRepo prunes ignored files and directories', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = await walkRepo(dir);
  assert.equal(all.files.length, 3);
  const gated = await walkRepo(dir, { ignore: (abs, isDir) => !isDir && ignoreSecret(abs) });
  assert.equal(gated.files.length, 1);
  assert.ok(gated.files[0]?.endsWith('main.ts'));
  assert.equal(gated.ignored, 2);
});

test('buildIndex honors the ignore predicate and drops now-ignored previous records', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 1st build: nothing ignored → 3 files.
  const first = await buildIndex(dir);
  assert.equal(first.index.files.length, 3);
  // 2nd build with the gate on: even though the previous index already
  // holds secret.ts, it is dropped (not reused).
  const second = await buildIndex(dir, {
    previous: first.index,
    ignore: (abs, isDir) => !isDir && ignoreSecret(abs),
  });
  assert.equal(second.index.files.length, 1);
  assert.equal(second.index.files[0]?.rel, 'src/main.ts');
});

test('service post-filter: a stale index cannot leak a file ignored after indexing', async (t) => {
  const dir = makeRepo();
  const cache = mkdtempSync(join(tmpdir(), 'cidx-cache-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });
  // Build the index WITHOUT the gate (file gets indexed)...
  const plain = new CodeIndexService({ cacheDir: cache, roots: [dir] });
  await plain.buildIndex(dir);
  const before = await plain.search(dir, 'topSecretFn', 'symbols');
  assert.equal(before.length, 1);
  // ...then a gated service over the SAME cache: query-time post-filter
  // hides it even before any rebuild.
  const gated = new CodeIndexService({
    cacheDir: cache,
    roots: [dir],
    ignoreCheck: (_root, abs, isDir) => !isDir && ignoreSecret(abs),
  });
  const after = await gated.search(dir, 'topSecretFn', 'symbols');
  assert.equal(after.length, 0);
  const text = await gated.search(dir, 'needleword', 'text');
  assert.equal(text.length, 0);
  // Ungated files still searchable.
  const ok = await gated.search(dir, 'helloMain', 'symbols');
  assert.equal(ok.length, 1);
});
