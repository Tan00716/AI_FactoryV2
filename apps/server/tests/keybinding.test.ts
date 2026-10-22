/**
 * Keybinding user-layer route tests (round-5 task R5-S1) — imports the route
 * from src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself), injects a temp-dir data root, and exercises
 * GET/PUT/DELETE/schema with a mock RouteContext.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/keybinding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleKeybindingRoutes,
  setKeybindingRootResolver,
  KEYBINDINGS_SCHEMA,
} from '../src/routes/keybinding.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'keybinding-srv-test-'));
setKeybindingRootResolver(() => TEST_ROOT);

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
  const handled = await handleKeybindingRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('GET returns empty user layer when no file exists', async () => {
  const { code, body } = await run('GET', '/api/keybindings', {});
  assert.equal(code, 200);
  assert.deepEqual((body as { keybindings: unknown[] }).keybindings, []);
});

test('PUT validates fail-closed and persists', async () => {
  const entries = [
    { command: 'palette.toggle', key: 'ctrl+shift+p' },
    { command: 'go.tab.terminal', key: 'ctrl+k ctrl+t' },
  ];
  const { code, body } = await run('PUT', '/api/keybindings', { keybindings: entries });
  assert.equal(code, 200);
  assert.deepEqual((body as { keybindings: unknown[] }).keybindings, entries);
  const onDisk = JSON.parse(readFileSync(join(TEST_ROOT, 'keybindings.json'), 'utf8'));
  assert.deepEqual(onDisk, entries);
  assert.ok(auditCalls.some((a) => a.event === 'KEYBINDINGS_UPDATED'));

  const get = await run('GET', '/api/keybindings', {});
  assert.deepEqual((get.body as { keybindings: unknown[] }).keybindings, entries);
});

test('PUT rejects invalid entries with per-entry issues', async () => {
  const { code, body } = await run('PUT', '/api/keybindings', {
    keybindings: [
      { command: 'palette.toggle', key: 'ctrl+shift+p' },
      { command: 'go.tab.terminal', key: 'hyper+zap' },
    ],
  });
  assert.equal(code, 400);
  const issues = (body as { issues: Array<{ index: number }> }).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].index, 1);
  assert.equal((body as { code: string }).code, 'keybindings-invalid');
});

test('PUT rejects non-array payload', async () => {
  const { code } = await run('PUT', '/api/keybindings', { keybindings: { nope: 1 } });
  assert.equal(code, 400);
});

test('PUT accepts key:null unbind entries', async () => {
  const { code } = await run('PUT', '/api/keybindings', {
    keybindings: [{ command: 'palette.toggle', key: null }],
  });
  assert.equal(code, 200);
});

test('DELETE resets to defaults', async () => {
  await run('PUT', '/api/keybindings', { keybindings: [{ command: 'a', key: 'ctrl+a' }] });
  const del = await run('DELETE', '/api/keybindings', {});
  assert.equal(del.code, 200);
  assert.deepEqual((del.body as { keybindings: unknown[] }).keybindings, []);
  const get = await run('GET', '/api/keybindings', {});
  assert.deepEqual((get.body as { keybindings: unknown[] }).keybindings, []);
  assert.ok(auditCalls.some((a) => a.event === 'KEYBINDINGS_RESET'));
});

test('GET /schema returns the documented schema', async () => {
  const { code, body } = await run('GET', '/api/keybindings/schema', {});
  assert.equal(code, 200);
  assert.equal((body as typeof KEYBINDINGS_SCHEMA).title, KEYBINDINGS_SCHEMA.title);
  assert.match((body as typeof KEYBINDINGS_SCHEMA).description, /no keyboard context/);
});

test('unknown sub-route is 404', async () => {
  const { code } = await run('GET', '/api/keybindings/nope', {});
  assert.equal(code, 404);
});
