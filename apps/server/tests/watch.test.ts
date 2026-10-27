/**
 * Watch trigger route tests (round-6 task R6-S3) — imports the route from
 * src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself). The chain runner is stubbed: these tests
 * verify rule CRUD, enable/disable lifecycle, the debounce fire path
 * (via a real TreeWatcher + real file writes), and failure recording —
 * not the task runner's own policy (routes/tasks.ts's responsibility).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/watch.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleWatchRoutes,
  resetWatchState,
  setWatchDeps,
} from '../src/routes/watch.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { ChainRunOutcome } from '../src/routes/tasks.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'watch-srv-test-'));

let chainCalls: Array<{ label: string; root: string }> = [];
let notified: unknown[] = [];
let audited: Array<{ event: string }> = [];

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: (_actor: string, event: string) => { audited.push({ event }); } },
    notify: { emit: (e: unknown) => { notified.push(e); } },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function call(method: string, path: string, body?: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleWatchRoutes(req(method), res, url(path), ctx);
  return { handled, calls };
}

const goodRule = {
  id: 'lint-watch',
  name: 'Lint on save',
  globs: ['src/**/*.ts'],
  action: { type: 'task', label: 'lint' },
  debounceMs: 100,
  enabled: true,
};

beforeEach(() => {
  chainCalls = [];
  notified = [];
  audited = [];
  resetWatchState();
  setWatchDeps({
    resolveRoot: (root?: string) => root ?? TEST_ROOT,
    shouldIgnore: () => false,
    runChain: async (label: string, root: string) => {
      chainCalls.push({ label, root });
      const outcome: ChainRunOutcome = {
        ok: true,
        chain: {
          requested: [label],
          results: [{ label, status: 'ok', exitCode: 0, durationMs: 1, output: '', truncated: false, diagnosticsAdded: 0, matchRate: 1 }],
          stoppedAt: null,
          ok: true,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      };
      return outcome;
    },
  });
  mkdirSync(join(TEST_ROOT, 'src'), { recursive: true });
});

afterEach(() => {
  resetWatchState();
});

test('rule CRUD: create, list, update, delete', async () => {
  const created = await call('POST', '/api/watch/rules', { root: TEST_ROOT, rule: goodRule });
  assert.equal(created.handled, true);
  assert.equal(created.calls[0].code, 201);
  const listed = await call('GET', `/api/watch/rules?root=${encodeURIComponent(TEST_ROOT)}`);
  const rules = (listed.calls[0].body as { rules: unknown[] }).rules;
  assert.equal(rules.length, 1);
  const dup = await call('POST', '/api/watch/rules', { root: TEST_ROOT, rule: goodRule });
  assert.equal(dup.calls[0].code, 409);
  const updated = await call('PUT', '/api/watch/rules/lint-watch', {
    root: TEST_ROOT,
    rule: { ...goodRule, name: 'Renamed', debounceMs: 200 },
  });
  assert.equal(updated.calls[0].code, 200);
  assert.equal((updated.calls[0].body as { rule: { name: string } }).rule.name, 'Renamed');
  const bad = await call('POST', '/api/watch/rules', {
    root: TEST_ROOT,
    rule: { ...goodRule, id: 'second', globs: ['/abs/*.ts'] },
  });
  assert.equal(bad.calls[0].code, 400);
  const deleted = await call('DELETE', `/api/watch/rules/lint-watch?root=${encodeURIComponent(TEST_ROOT)}`);
  assert.equal(deleted.calls[0].code, 200);
  const listed2 = await call('GET', `/api/watch/rules?root=${encodeURIComponent(TEST_ROOT)}`);
  assert.equal((listed2.calls[0].body as { rules: unknown[] }).rules.length, 0);
});

test('enable starts a real watcher; a file change fires the chain once (debounced)', async () => {
  await call('POST', '/api/watch/rules', { root: TEST_ROOT, rule: goodRule });
  const enabled = await call('POST', '/api/watch/rules/lint-watch/enable', { root: TEST_ROOT });
  assert.equal(enabled.calls[0].code, 200);
  writeFileSync(join(TEST_ROOT, 'src', 'a.ts'), 'v1', 'utf8');
  writeFileSync(join(TEST_ROOT, 'src', 'a.ts'), 'v2', 'utf8');
  writeFileSync(join(TEST_ROOT, 'src', 'b.ts'), 'v1', 'utf8');
  // Debounce (100ms) + chain run: poll for the trigger record.
  for (let i = 0; i < 40 && chainCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(chainCalls.length, 1);
  assert.equal(chainCalls[0].label, 'lint');
  const triggers = await call('GET', `/api/watch/triggers?root=${encodeURIComponent(TEST_ROOT)}`);
  const list = (triggers.calls[0].body as { triggers: Array<{ status: string; files: string[] }> }).triggers;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'ok');
  assert.deepEqual(list[0].files, ['src/a.ts', 'src/b.ts']);
  const status = await call('GET', `/api/watch/status?root=${encodeURIComponent(TEST_ROOT)}`);
  assert.equal((status.calls[0].body as { active: unknown[] }).active.length, 1);
  const disabled = await call('POST', '/api/watch/rules/lint-watch/disable', { root: TEST_ROOT });
  assert.equal(disabled.calls[0].code, 200);
  assert.equal(disabled.calls[0].body && (disabled.calls[0].body as { wasActive: boolean }).wasActive, true);
});

test('failed chain records failure and emits a notification', async () => {
  setWatchDeps({
    resolveRoot: (root?: string) => root ?? TEST_ROOT,
    shouldIgnore: () => false,
    runChain: async () => ({
      ok: true,
      chain: {
        requested: ['lint'],
        results: [{ label: 'lint', status: 'failed', exitCode: 1, durationMs: 1, output: '', truncated: false, diagnosticsAdded: 0, matchRate: 1, error: 'task exited with code 1' }],
        stoppedAt: 'lint',
        ok: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    }),
  });
  await call('POST', '/api/watch/rules', { root: TEST_ROOT, rule: goodRule });
  await call('POST', '/api/watch/rules/lint-watch/enable', { root: TEST_ROOT });
  writeFileSync(join(TEST_ROOT, 'src', 'c.ts'), 'v1', 'utf8');
  for (let i = 0; i < 40 && notified.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(notified.length, 1);
  assert.equal((notified[0] as { type: string }).type, 'GENERIC');
  assert.equal(audited.some((a) => a.event === 'WATCH_TRIGGER_FAILED'), true);
  const triggers = await call('GET', `/api/watch/triggers?root=${encodeURIComponent(TEST_ROOT)}`);
  const list = (triggers.calls[0].body as { triggers: Array<{ status: string }> }).triggers;
  assert.equal(list[0].status, 'failed');
});

test('ignored files never fire; unknown rule enable 404s', async () => {
  setWatchDeps({
    resolveRoot: (root?: string) => root ?? TEST_ROOT,
    shouldIgnore: (_root: string, abs: string) => abs.includes('ignored'),
    runChain: async (label: string, root: string) => {
      chainCalls.push({ label, root });
      return {
        ok: true,
        chain: {
          requested: [label], results: [], stoppedAt: null, ok: true,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        },
      };
    },
  });
  await call('POST', '/api/watch/rules', {
    root: TEST_ROOT,
    rule: { ...goodRule, globs: ['**/*.ts'] },
  });
  await call('POST', '/api/watch/rules/lint-watch/enable', { root: TEST_ROOT });
  mkdirSync(join(TEST_ROOT, 'ignored'), { recursive: true });
  writeFileSync(join(TEST_ROOT, 'ignored', 'x.ts'), 'v1', 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chainCalls.length, 0);
  const missing = await call('POST', '/api/watch/rules/nope/enable', { root: TEST_ROOT });
  assert.equal(missing.calls[0].code, 404);
  assert.equal(existsSync(join(TEST_ROOT, '.ai-factory', 'watch.json')), true);
});
