/**
 * Data-file preview route tests (round-6 task R6-B10) — imports the
 * route from src with type-stripping (dual-mode rule: no src-relative
 * value imports inside the route itself), injects a temp-dir root
 * resolver, and exercises preview + fail-closed paths.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/datapreview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleDataPreviewRoutes, setDataPreviewRootResolver } from '../src/routes/datapreview.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'datapreview-srv-test-'));
setDataPreviewRootResolver((root) => {
  if (root === undefined || root === TEST_ROOT) return TEST_ROOT;
  throw new Error(`inspection root is outside the allowed roots: ${root}`);
});

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(method: string, path: string, body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleDataPreviewRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0] as { code: number; body: Record<string, unknown> };
}

test('jsonl preview: rows, columns, pagination', async () => {
  writeFileSync(join(TEST_ROOT, 'a.jsonl'), '{"n":1,"s":"x"}\n{"n":2,"s":"y"}\n{"n":3}\n');
  const r = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'a.jsonl', pageSize: 2 });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body['columns'], ['n', 's']);
  assert.equal(r.body['totalRows'], 3);
  assert.equal(r.body['totalPages'], 2);
  assert.deepEqual(r.body['rows'], [['1', 'x'], ['2', 'y']]);
});

test('csv preview: quoted fields, sort, filter', async () => {
  writeFileSync(join(TEST_ROOT, 'b.csv'), 'name,n\n"Doe, Jane",10\na,2\n');
  const sorted = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'b.csv', sortColumn: 'n', sortDir: 'desc' });
  assert.equal(sorted.code, 200);
  assert.deepEqual(sorted.body['rows'], [['Doe, Jane', '10'], ['a', '2']]);
  const filtered = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'b.csv', filter: 'doe' });
  assert.equal(filtered.body['filteredRows'], 1);
});

test('malformed rows counted, format override works', async () => {
  writeFileSync(join(TEST_ROOT, 'c.txt'), '{"a":1}\nbroken\n{"a":2}\n');
  const r = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'c.txt', format: 'jsonl' });
  assert.equal(r.code, 200);
  assert.equal(r.body['malformedRows'], 1);
  assert.equal(r.body['totalRows'], 2);
});

test('fail-closed: escape 403, missing 404, bad type 415, bad format 400', async () => {
  const esc = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: '../secret.jsonl' });
  assert.equal(esc.code, 403);
  const miss = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'nope.jsonl' });
  assert.equal(miss.code, 404);
  writeFileSync(join(TEST_ROOT, 'd.md'), '# hi\n');
  const bad = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'd.md' });
  assert.equal(bad.code, 415);
  const fmt = await run('POST', '/api/datapreview/preview', { root: TEST_ROOT, path: 'd.md', format: 'xml' });
  assert.equal(fmt.code, 400);
});

test('unhandled paths and methods return false', async () => {
  const { ctx } = mockCtx({});
  assert.equal(await handleDataPreviewRoutes(req('GET'), res, url('/api/datapreview/preview'), ctx), false);
  assert.equal(await handleDataPreviewRoutes(req('POST'), res, url('/api/other'), ctx), false);
});
