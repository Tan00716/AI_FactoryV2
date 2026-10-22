/**
 * Snippet route tests (round-5 task R5-A6) — imports the route from src with
 * type-stripping, injects a temp-dir inspection root, and exercises
 * GET/PUT/schema with a mock RouteContext.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleSnippetRoutes,
  setSnippetInspectionRootResolver,
  SNIPPETS_SCHEMA,
} from '../src/routes/snippets.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'snippets-srv-test-'));
setSnippetInspectionRootResolver(() => TEST_ROOT);

const auditCalls: Array<{ event: string }> = [];
function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: (_actor: unknown, event: string) => { auditCalls.push({ event }); } },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(method: string, path: string, body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleSnippetRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('GET returns empty list when no snippets.json exists', async () => {
  const { code, body } = await run('GET', '/api/snippets', {});
  assert.equal(code, 200);
  assert.deepEqual((body as { snippets: unknown[] }).snippets, []);
});

test('PUT validates fail-closed and persists to .ai-factory/snippets.json', async () => {
  const entries = [
    { id: 'my-for', trigger: 'for', description: 'loop', scope: ['typescript'], body: 'for (${1:i} of ${2:l}) {\n\t$0\n}' },
  ];
  const put = await run('PUT', '/api/snippets', { snippets: entries });
  assert.equal(put.code, 200);
  const raw = readFileSync(join(TEST_ROOT, '.ai-factory', 'snippets.json'), 'utf8');
  const stored = JSON.parse(raw) as { snippets: unknown[] };
  assert.equal(stored.snippets.length, 1);

  const get = await run('GET', '/api/snippets', {});
  assert.equal(get.code, 200);
  assert.equal((get.body as { snippets: unknown[] }).snippets.length, 1);
  assert.ok(auditCalls.some((c) => c.event === 'SNIPPETS_UPDATED'));
});

test('PUT rejects invalid snippets with 400 and writes nothing new', async () => {
  const bad = await run('PUT', '/api/snippets', {
    snippets: [{ id: 'bad id!', trigger: '', scope: [], body: '${1:${2:x}}' }],
  });
  assert.equal(bad.code, 400);
  assert.match(JSON.stringify(bad.body), /snippets-invalid/);
  // Previously stored valid snippets are untouched.
  const get = await run('GET', '/api/snippets', {});
  assert.equal((get.body as { snippets: unknown[] }).snippets.length, 1);
});

test('GET /schema returns documentation schema', async () => {
  const { code, body } = await run('GET', '/api/snippets/schema', {});
  assert.equal(code, 200);
  assert.equal((body as typeof SNIPPETS_SCHEMA).title, SNIPPETS_SCHEMA.title);
});

test('unknown sub-path returns 404', async () => {
  const { code } = await run('GET', '/api/snippets/nope', {});
  assert.equal(code, 404);
});
