/**
 * Code search route tests (round-5 task R5-A8) — imports the route from
 * src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself), injects a temp-dir root, and exercises
 * POST /api/codesearch/search with a mock RouteContext.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/codesearch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleCodeSearchRoutes,
  setCodeSearchRootResolver,
} from '../src/routes/codesearch.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'codesearch-srv-test-'));
writeFileSync(join(TEST_ROOT, 'alpha.ts'), 'export const needle = 1;\n// needle: found here\n');
mkdirSync(join(TEST_ROOT, 'nested'));
writeFileSync(join(TEST_ROOT, 'nested', 'beta.md'), '# docs\nneedle in docs\n');

setCodeSearchRootResolver(() => TEST_ROOT);

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: () => undefined },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(method: string, path: string, body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleCodeSearchRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('POST searches the project root', async () => {
  const { code, body } = await run('POST', '/api/codesearch/search', { query: 'needle' });
  assert.equal(code, 200);
  const b = body as { totalMatches: number; groups: Array<{ file: string }> };
  assert.equal(b.totalMatches, 3);
  assert.deepEqual(b.groups.map((g) => g.file), ['alpha.ts', 'nested/beta.md']);
});

test('regex + caseSensitive + glob narrow results', async () => {
  const { code, body } = await run('POST', '/api/codesearch/search', {
    query: 'needle:\\s*\\w+',
    regex: true,
    glob: '*.ts',
  });
  assert.equal(code, 200);
  const b = body as { totalMatches: number; groups: Array<{ file: string }> };
  assert.equal(b.totalMatches, 1);
  assert.deepEqual(b.groups.map((g) => g.file), ['alpha.ts']);
});

test('missing query is 400 fail-closed', async () => {
  const { code, body } = await run('POST', '/api/codesearch/search', {});
  assert.equal(code, 400);
  assert.match((body as { error: string }).error, /required/);
});

test('bad regex is 400, not a crash', async () => {
  const { code } = await run('POST', '/api/codesearch/search', { query: '([', regex: true });
  assert.equal(code, 400);
});

test('unresolved root is 403', async () => {
  setCodeSearchRootResolver(() => {
    throw new Error('outside the allowed roots');
  });
  try {
    const { code } = await run('POST', '/api/codesearch/search', { query: 'needle' });
    assert.equal(code, 403);
  } finally {
    setCodeSearchRootResolver(() => TEST_ROOT);
  }
});

test('unrelated paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleCodeSearchRoutes(req('GET'), res, url('/api/codesearch/other'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
