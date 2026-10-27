/**
 * Rules route tests (round-6 task R6-A6) — imports the route from src
 * with type-stripping, injects a temp global dir + a temp project root,
 * and exercises CRUD, reorder, override merge, compat read, and jail
 * with a mock RouteContext.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/rules.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleRulesRoutes,
  setRulesGlobalDirResolver,
  setRulesInspectionRootResolver,
} from '../src/routes/rules.ts';
import type { RouteContext } from '../src/routes/context.ts';

const GLOBAL_DIR = mkdtempSync(join(tmpdir(), 'rules-global-'));
const PROJ = mkdtempSync(join(tmpdir(), 'rules-proj-'));
writeFileSync(join(PROJ, 'AGENTS.md'), '# Project agents rules\n', 'utf8');
writeFileSync(join(PROJ, '.cursorrules'), 'cursor rules\n', 'utf8');

setRulesGlobalDirResolver(() => GLOBAL_DIR);
setRulesInspectionRootResolver((root?: string) => {
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
const enc = (s: string) => encodeURIComponent(s);

async function run(method: string, path: string, body: unknown = {}) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleRulesRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('GET starts empty except compat; POST adds global + project rules', async () => {
  const g0 = await run('GET', `/api/rules?root=${enc(PROJ)}`);
  assert.equal(g0.code, 200);
  const v0 = g0.body as { global: unknown[]; project: unknown[]; compat: Array<{ file: string }>; effective: unknown[] };
  assert.deepEqual(v0.global, []);
  assert.deepEqual(v0.project, []);
  assert.deepEqual(v0.compat.map((c) => c.file), ['AGENTS.md', '.cursorrules']);
  assert.equal(v0.effective.length, 2); // compat entries only
  assert.ok(v0.effective.every((e) => (e as { readOnly: boolean }).readOnly));

  const g1 = await run('POST', '/api/rules', { scope: 'global', name: 'lint', content: 'global lint' });
  assert.equal(g1.code, 201);
  const p1 = await run('POST', '/api/rules', { scope: 'project', name: 'style', content: 'project style', root: PROJ });
  assert.equal(p1.code, 201);
  const g2 = await run('GET', `/api/rules?root=${enc(PROJ)}`);
  const v2 = g2.body as { global: Array<{ name: string; overriddenBy: string | null }>; project: Array<{ name: string }>; effective: Array<{ name: string; scope: string }> };
  assert.deepEqual(v2.global.map((r) => r.name), ['lint']);
  assert.deepEqual(v2.project.map((r) => r.name), ['style']);
  assert.deepEqual(v2.effective.map((e) => e.name), ['lint', 'style', 'AGENTS.md', '.cursorrules']);
  assert.ok(auditCalls.includes('RULE_ADDED'));
});

test('project rule overrides same-named global rule, labelled', async () => {
  const add = await run('POST', '/api/rules', { scope: 'project', name: 'LINT', content: 'project lint', root: PROJ });
  assert.equal(add.code, 201);
  const g = await run('GET', `/api/rules?root=${enc(PROJ)}`);
  const v = g.body as {
    global: Array<{ name: string; overriddenBy: string | null }>;
    effective: Array<{ name: string; scope: string; overrides: string[] }>;
  };
  const globalLint = v.global.find((r) => r.name === 'lint');
  assert.ok(globalLint && globalLint.overriddenBy);
  const effLint = v.effective.find((e) => e.name === 'LINT');
  assert.equal(effLint?.scope, 'project');
  assert.deepEqual(effLint?.overrides, [(globalLint as { id: string }).id]);
  assert.equal(globalLint.overriddenBy, effLint?.id);
  assert.equal(v.effective.filter((e) => e.name.toLowerCase() === 'lint').length, 1);
});

test('duplicate name, bad name, and reorder permutation are rejected', async () => {
  const dup = await run('POST', '/api/rules', { scope: 'global', name: 'LINT', content: 'x' });
  assert.equal(dup.code, 400);
  const bad = await run('POST', '/api/rules', { scope: 'global', name: '../x', content: 'x' });
  assert.equal(bad.code, 400);
  const g = await run('GET', '/api/rules');
  const ids = (g.body as { global: Array<{ id: string }> }).global.map((r) => r.id);
  assert.ok(ids.length >= 1);
  const badOrder = await run('POST', '/api/rules/order', { scope: 'global', ids: ids.slice(0, -1) });
  assert.equal(badOrder.code, 400);
  const goodOrder = await run('POST', '/api/rules/order', { scope: 'global', ids: [...ids].reverse() });
  assert.equal(goodOrder.code, 200);
});

test('PATCH enable toggle + DELETE + jail 403', async () => {
  const g = await run('GET', '/api/rules');
  const id = (g.body as { global: Array<{ id: string }> }).global[0].id;
  const patched = await run('PATCH', `/api/rules?id=${enc(id)}&scope=global`, { enabled: false });
  assert.equal(patched.code, 200);
  assert.equal((patched.body as { rule: { enabled: boolean } }).rule.enabled, false);
  const missing = await run('PATCH', '/api/rules?id=ghost&scope=global', { enabled: true });
  assert.equal(missing.code, 404);
  const deleted = await run('DELETE', `/api/rules?id=${enc(id)}&scope=global`);
  assert.equal(deleted.code, 200);
  const jailed = await run('GET', '/api/rules?root=/etc');
  assert.equal(jailed.code, 403);
});
