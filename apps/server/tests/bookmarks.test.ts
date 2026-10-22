/**
 * Bookmark route tests (round-5 task R5-B9) — imports the route from src
 * with type-stripping, injects a temp data dir + a temp project root, and
 * exercises CRUD, toggle, resolve (drift), jail, and mnemonic uniqueness
 * with a mock RouteContext.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/bookmarks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleBookmarkRoutes,
  setBookmarkDataDirResolver,
  setBookmarkInspectionRootResolver,
} from '../src/routes/bookmarks.ts';
import type { RouteContext } from '../src/routes/context.ts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'bookmarks-data-'));
const PROJ = mkdtempSync(join(tmpdir(), 'bookmarks-proj-'));
mkdirSync(join(PROJ, 'src'), { recursive: true });
const FILE = join(PROJ, 'src', 'a.ts');
const TEXT = Array.from({ length: 20 }, (_, i) => `line ${i + 1} content`).join('\n');
writeFileSync(FILE, TEXT, 'utf8');

setBookmarkDataDirResolver(() => DATA_DIR);
// The jail resolver: only PROJ is allowed; anything else throws (403).
setBookmarkInspectionRootResolver((root?: string) => {
  if (root === undefined || root === PROJ) return PROJ;
  throw new Error(`inspection root is outside the allowed roots: ${root}`);
});

const auditCalls: string[] = [];
function mockCtx(body: unknown) {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: (_a: unknown, event: string) => { auditCalls.push(event); } },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(method: string, path: string, body: unknown = {}) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleBookmarkRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

const asBookmarks = (b: unknown) => (b as { bookmarks: Array<{ id: string }> }).bookmarks;

test('GET starts empty; POST adds a line bookmark with context', async () => {
  const g0 = await run('GET', '/api/bookmarks');
  assert.deepEqual(asBookmarks(g0.body), []);
  const { code, body } = await run('POST', '/api/bookmarks', {
    kind: 'line', path: 'src/a.ts', line: 10, mnemonic: '5', label: 'hot loop',
  });
  assert.equal(code, 201);
  const bm = (body as { bookmark: Record<string, unknown> }).bookmark;
  assert.equal(bm['kind'], 'line');
  assert.equal(bm['line'], 10);
  assert.equal(bm['mnemonic'], '5');
  assert.ok(typeof bm['contextHash'] === 'string' && (bm['contextHash'] as string).length === 64);
  assert.equal((bm['contextLines'] as string[]).length, 5);
  assert.ok(auditCalls.includes('BOOKMARK_ADDED'));
});

test('duplicate mnemonic is rejected fail-closed', async () => {
  const { code, body } = await run('POST', '/api/bookmarks', {
    kind: 'file', path: 'src/a.ts', mnemonic: '5',
  });
  assert.equal(code, 400);
  assert.match((body as { error: string }).error, /already used/);
});

test('path escape is 403', async () => {
  const { code } = await run('POST', '/api/bookmarks', { kind: 'file', path: '../../etc/passwd' });
  assert.equal(code, 403);
});

test('resolve returns ok when content unchanged', async () => {
  const list = asBookmarks((await run('GET', '/api/bookmarks')).body);
  const id = list[0].id;
  const { code, body } = await run('POST', '/api/bookmarks/resolve', { id });
  assert.equal(code, 200);
  assert.equal((body as { status: string }).status, 'ok');
  assert.equal((body as { line: number }).line, 10);
});

test('resolve relocates after insertion above, drifts after rewrite', async () => {
  const list = asBookmarks((await run('GET', '/api/bookmarks')).body);
  const id = list[0].id;
  writeFileSync(FILE, `inserted\n${TEXT}`, 'utf8');
  const r1 = await run('POST', '/api/bookmarks/resolve', { id });
  assert.equal((r1.body as { status: string }).status, 'relocated');
  assert.equal((r1.body as { line: number }).line, 11);
  writeFileSync(FILE, Array.from({ length: 20 }, (_, i) => `different ${i}`).join('\n'), 'utf8');
  const r2 = await run('POST', '/api/bookmarks/resolve', { id });
  assert.equal((r2.body as { status: string }).status, 'drifted');
  assert.equal((r2.body as { drifted: boolean }).drifted, true);
  writeFileSync(FILE, TEXT, 'utf8'); // restore for later tests
});

test('toggle adds then removes the same line bookmark', async () => {
  const t1 = await run('POST', '/api/bookmarks/toggle', { path: 'src/a.ts', line: 3 });
  assert.equal(t1.code, 201);
  assert.equal((t1.body as { added: boolean }).added, true);
  const t2 = await run('POST', '/api/bookmarks/toggle', { path: 'src/a.ts', line: 3 });
  assert.equal(t2.code, 200);
  assert.equal((t2.body as { added: boolean }).added, false);
});

test('PATCH renames and clears mnemonic; DELETE removes', async () => {
  const list = asBookmarks((await run('GET', '/api/bookmarks')).body);
  const id = list[0].id;
  const p = await run('PATCH', `/api/bookmarks?id=${id}`, { label: 'renamed', mnemonic: null });
  assert.equal(p.code, 200);
  assert.equal((p.body as { bookmark: { label: string } }).bookmark.label, 'renamed');
  const d = await run('DELETE', `/api/bookmarks?id=${id}`);
  assert.equal(d.code, 200);
  assert.ok(auditCalls.includes('BOOKMARK_REMOVED'));
  const missing = await run('DELETE', `/api/bookmarks?id=${id}`);
  assert.equal(missing.code, 404);
});

test('unrelated path is not claimed', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleBookmarkRoutes(req('GET'), res, url('/api/other'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
