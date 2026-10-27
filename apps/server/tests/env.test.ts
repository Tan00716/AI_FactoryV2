/**
 * .env route tests (round-6 task R6-A8) — imports the route from src with
 * type-stripping (dual-mode rule: no src-relative value imports inside
 * the route itself). The jail resolver and the chain runner are stubbed;
 * these tests verify masking, warnings, roundtrip writes, reveal audit,
 * and the load overlay — not the task runner's own policy.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/env.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleEnvRoutes, setEnvDeps } from '../src/routes/env.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'env-srv-test-'));

let audited: Array<{ event: string; detail: unknown }> = [];
let chainCalls: Array<{ label: string; env: Record<string, string> }> = [];

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: {
      record: (_actor: string, event: string, _kind: string, _id: string, detail?: unknown) => {
        audited.push({ event, detail });
      },
    },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function call(method: string, path: string, body?: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleEnvRoutes(req(method), res, url(path), ctx);
  return { handled, calls };
}

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const FIXTURE = `# header\n\nPORT=3000\nAPI_TOKEN=${SECRET}\nOTHER=dup-one\nOTHER=dup-two\nBADLINE\n`;

beforeEach(() => {
  audited = [];
  chainCalls = [];
  setEnvDeps({
    resolveRoot: (root?: string) => {
      const abs = resolve(TEST_ROOT, root ?? '.');
      if (abs !== TEST_ROOT && !abs.startsWith(TEST_ROOT + '/')) throw new Error('root escapes jail');
      return abs;
    },
    runChain: async (label, _root, _pid, _actor, _ctx, env) => {
      chainCalls.push({ label, env });
      return { ok: true, chain: { ok: true, results: [], stoppedAt: null } } as never;
    },
  });
  writeFileSync(join(TEST_ROOT, '.env'), FIXTURE, 'utf8');
});

afterEach(() => {
  setEnvDeps(null);
});

test('list: values masked, secret + duplicate + parse warnings, no plaintext', async () => {
  const { handled, calls } = await call('GET', '/api/env?root=.');
  assert.equal(handled, true);
  assert.equal(calls[0].code, 200);
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body['exists'], true);
  const entries = body['entries'] as Array<Record<string, unknown>>;
  const token = entries.find((e) => e.key === 'API_TOKEN');
  assert.ok(token);
  assert.equal(token['secret'], true);
  assert.ok((token['patterns'] as string[]).includes('github-pat-classic'));
  assert.notEqual(token['masked'], SECRET);
  assert.ok(!JSON.stringify(body).includes(SECRET), 'list payload must never contain the secret');
  const warnings = body['warnings'] as Array<Record<string, unknown>>;
  assert.ok(warnings.some((w) => w['kind'] === 'secret-like' && w['key'] === 'API_TOKEN'));
  assert.ok(warnings.some((w) => w['kind'] === 'duplicate' && w['key'] === 'OTHER'));
  assert.ok(warnings.some((w) => w['kind'] === 'parse-error'));
});

test('list: gitignore hint reflects .gitignore content', async () => {
  writeFileSync(join(TEST_ROOT, '.gitignore'), 'node_modules\n.env\n', 'utf8');
  const { calls } = await call('GET', '/api/env?root=.');
  const gitignore = (calls[0].body as Record<string, unknown>)['gitignore'] as Record<string, unknown>;
  assert.equal(gitignore['ignored'], true);
  assert.equal(gitignore['hasGitignore'], true);
});

test('reveal: returns plaintext and audits key only, never the value', async () => {
  const { calls } = await call('GET', '/api/env/reveal?root=.&key=PORT');
  assert.equal(calls[0].code, 200);
  assert.equal((calls[0].body as Record<string, unknown>)['value'], '3000');
  const audit = audited.find((a) => a.event === 'ENV_VALUE_REVEALED');
  assert.ok(audit);
  assert.equal((audit.detail as Record<string, unknown>)['key'], 'PORT');
  assert.ok(!('value' in (audit.detail as Record<string, unknown>)));
});

test('reveal: unknown key 404, invalid key 400', async () => {
  const a = await call('GET', '/api/env/reveal?root=.&key=NOPE');
  assert.equal(a.calls[0].code, 404);
  const b = await call('GET', '/api/env/reveal?root=.&key=1BAD');
  assert.equal(b.calls[0].code, 400);
});

test('entries: set/delete roundtrip preserves comments and blanks', async () => {
  const { calls } = await call('POST', '/api/env/entries', {
    root: '.',
    set: [{ key: 'NEW_KEY', value: 'hello world' }],
    delete: ['PORT'],
  });
  assert.equal(calls[0].code, 200);
  const text = readFileSync(join(TEST_ROOT, '.env'), 'utf8');
  assert.ok(text.startsWith('# header\n\n'), 'comments and blanks preserved');
  assert.ok(!text.includes('PORT='), 'PORT deleted');
  assert.ok(text.includes('NEW_KEY="hello world"'), 'new key appended quoted');
  const audit = audited.find((a) => a.event === 'ENV_UPDATED');
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit).includes('hello world'), 'audit must not carry values');
});

test('entries: invalid key 400, crafted file name 400, jail escape 403', async () => {
  const a = await call('POST', '/api/env/entries', { root: '.', set: [{ key: '1BAD', value: 'x' }] });
  assert.equal(a.calls[0].code, 400);
  const b = await call('POST', '/api/env/entries', { root: '.', file: '../evil', set: [] });
  assert.equal(b.calls[0].code, 400);
  const c = await call('GET', '/api/env?root=..');
  assert.equal(c.calls[0].code, 403);
});

test('validate: missing keys reported', async () => {
  const { calls } = await call('POST', '/api/env/validate', { root: '.', required: ['PORT', 'MISSING_ONE'] });
  assert.equal(calls[0].code, 200);
  assert.deepEqual((calls[0].body as Record<string, unknown>)['missing'], ['MISSING_ONE']);
});

test('load: passes effective env overlay to the chain runner, audits keys only', async () => {
  const { calls } = await call('POST', '/api/env/load', { root: '.', label: 'hello' });
  assert.equal(calls[0].code, 200);
  assert.equal(chainCalls.length, 1);
  assert.equal(chainCalls[0].label, 'hello');
  assert.equal(chainCalls[0].env['PORT'], '3000');
  assert.equal(chainCalls[0].env['API_TOKEN'], SECRET, 'secret value passes through the overlay');
  assert.equal(chainCalls[0].env['OTHER'], 'dup-two', 'last duplicate wins in overlay');
  const audit = audited.find((a) => a.event === 'ENV_LOADED_TO_TASK');
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit).includes(SECRET), 'load audit must not carry values');
  assert.ok(((audit.detail as Record<string, unknown>)['keys'] as string[]).includes('PORT'));
});

test('load: missing file 404, empty label 400', async () => {
  const a = await call('POST', '/api/env/load', { root: '.', file: '.env.nope', label: 'hello' });
  assert.equal(a.calls[0].code, 404);
  const b = await call('POST', '/api/env/load', { root: '.', label: '' });
  assert.equal(b.calls[0].code, 400);
});

test('list: missing file reports exists false with empty entries', async () => {
  const { calls } = await call('GET', '/api/env?root=.&file=.env.local');
  assert.equal(calls[0].code, 200);
  assert.equal((calls[0].body as Record<string, unknown>)['exists'], false);
  assert.deepEqual((calls[0].body as Record<string, unknown>)['entries'], []);
});
