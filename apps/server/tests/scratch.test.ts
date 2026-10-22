/**
 * Scratch file route tests (round-5 task R5-B10) — imports the route from
 * src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself), injects a temp-dir data root, and exercises
 * CRUD + the run endpoint with a stub exec policy.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/scratch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleScratchRoutes, setScratchDeps } from '../src/routes/scratch.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'scratch-srv-test-'));
// Mirror the policy: allow node only, deny everything else, never touch
// the control dir. This is a TEST STUB of the shared policy shape — the
// real policy lives in routes/exec.ts and is wired in index.ts.
setScratchDeps({
  resolveDataDir: () => TEST_ROOT,
  checkCommandPolicy: (command: string) => {
    const m = /^node "(.+)"$/.exec(command.trim());
    if (!m) {
      const e = new Error(`command refused: ${command}`);
      e.name = 'ExecPolicyDenied';
      throw e;
    }
    return ['node', m[1]];
  },
  commandHitsControlDir: () => false,
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
  const handled = await handleScratchRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0] as { code: number; body: Record<string, unknown> };
}

test('full CRUD lifecycle', async () => {
  const created = await run('POST', '/api/scratches', { language: 'typescript', name: 'hello' });
  assert.equal(created.code, 201);
  const id = (created.body.scratch as { id: string }).id;
  assert.ok(id);

  const listed = await run('GET', '/api/scratches', {});
  assert.equal(listed.code, 200);
  assert.equal((listed.body.scratches as unknown[]).length, 1);
  const langs = listed.body.languages as Array<{ id: string; runnable: boolean }>;
  assert.ok(langs.some((l) => l.id === 'typescript' && l.runnable === true));
  assert.ok(langs.some((l) => l.id === 'markdown' && l.runnable === false));

  const saved = await run('PUT', `/api/scratches/${id}`, { content: 'export const x = 1;\n' });
  assert.equal(saved.code, 200);
  assert.ok(((saved.body.scratch as { sizeBytes: number }).sizeBytes) > 0);

  const got = await run('GET', `/api/scratches/${id}`, {});
  assert.equal(got.code, 200);
  assert.equal((got.body.scratch as { content: string }).content, 'export const x = 1;\n');

  const renamed = await run('PUT', `/api/scratches/${id}`, { name: 'renamed' });
  assert.equal(renamed.code, 200);
  assert.equal((renamed.body.scratch as { name: string }).name, 'renamed');

  const deleted = await run('DELETE', `/api/scratches/${id}`, {});
  assert.equal(deleted.code, 200);
  const missing = await run('GET', `/api/scratches/${id}`, {});
  assert.equal(missing.code, 404);
  assert.equal(missing.body.code, 'not-found');
});

test('create rejects unknown language; bad id is 400/404', async () => {
  const bad = await run('POST', '/api/scratches', { language: 'cobol' });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.code, 'bad-language');
  const missing = await run('GET', '/api/scratches/nope', {});
  assert.equal(missing.code, 400);
  assert.equal(missing.body.code, 'bad-id');
});

test('run executes node and returns output', async () => {
  const created = await run('POST', '/api/scratches', { language: 'javascript' });
  const id = (created.body.scratch as { id: string }).id;
  await run('PUT', `/api/scratches/${id}`, { content: 'console.log(6 * 7);\n' });
  const ran = await run('POST', `/api/scratches/${id}/run`, {});
  assert.equal(ran.code, 200);
  const r = ran.body.run as { ok: boolean; exitCode: number; stdout: string; runner: string };
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '42\n');
  assert.equal(r.runner, 'node');
});

test('run reports non-zero exit honestly', async () => {
  const created = await run('POST', '/api/scratches', { language: 'javascript' });
  const id = (created.body.scratch as { id: string }).id;
  await run('PUT', `/api/scratches/${id}`, { content: 'process.exit(3);\n' });
  const ran = await run('POST', `/api/scratches/${id}/run`, {});
  assert.equal(ran.code, 200);
  const r = ran.body.run as { ok: boolean; exitCode: number };
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});

test('run refuses edit-only languages with an honest reason', async () => {
  const created = await run('POST', '/api/scratches', { language: 'markdown' });
  const id = (created.body.scratch as { id: string }).id;
  const ran = await run('POST', `/api/scratches/${id}/run`, {});
  assert.equal(ran.code, 400);
  assert.equal(ran.body.code, 'runner-unsupported');
});

test('unmatched paths are not claimed by the router', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleScratchRoutes(req('GET'), res, url('/api/other'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
