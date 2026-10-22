/**
 * HTTP/REST client route tests (round-4 task A6) — imports the route from
 * src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself), injects the REAL egress gate from
 * ../src/egress.ts (node builtins only — type-stripping safe), and runs
 * real requests against a local fixture server on 127.0.0.1.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/httpclient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  handleHttpClientRoutes,
  setHttpClientEgressGate,
  setHttpClientRootResolver,
} from '../src/routes/httpclient.ts';
import { assertEgressAllowed, resetEgressStoreForTests } from '../src/egress.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'httpclient-srv-test-'));

setHttpClientRootResolver(() => TEST_ROOT);
setHttpClientEgressGate((url) => assertEgressAllowed(url, { source: 'http-client' }));

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: () => {} },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleHttpClientRoutes(req('POST'), res, url('/api/http/run'), ctx);
  assert.equal(handled, true);
  return calls[0];
}

function fixture() {
  const server = createServer((fq, fs2) => {
    if (fq.url === '/api/health') {
      fs2.writeHead(200, { 'content-type': 'application/json' });
      fs2.end(JSON.stringify({ ok: true, version: '9.9.9' }));
    } else {
      fs2.writeHead(404, { 'content-type': 'text/plain' });
      fs2.end('nope');
    }
  });
  return new Promise<{ server: typeof server; base: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('real request with env substitution + all assertions pass', async () => {
  const { server, base } = await fixture();
  try {
    const c = await run({
      text: `### health probe
GET {{baseUrl}}/api/health
> status == 200
> header content-type contains json
> body contains "ok"
> json-path $.ok == true
> max-time-ms 5000
`,
      environments: { local: { vars: { baseUrl: base } } },
      environment: 'local',
    });
    assert.equal(c.code, 200);
    const body = c.body as { results: Array<{ ok: boolean; status: number; assertions: Array<{ passed: boolean }> }> };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, 200);
    assert.ok(body.results[0].ok, JSON.stringify(body.results[0]));
    assert.ok(body.results[0].assertions.every((a) => a.passed));
  } finally {
    server.close();
  }
});

test('assertion failure path → ok false, per-assertion detail', async () => {
  const { server, base } = await fixture();
  try {
    const c = await run({
      text: `GET ${base}/api/health\n> status == 404\n> json-path $.missing exists\n`,
    });
    assert.equal(c.code, 200);
    const body = c.body as { results: Array<{ ok: boolean; assertions: Array<{ passed: boolean; detail: string }> }> };
    assert.ok(!body.results[0].ok);
    assert.equal(body.results[0].assertions.filter((a) => !a.passed).length, 2);
  } finally {
    server.close();
  }
});

test('parse error → 400 with line number', async () => {
  const c = await run({ text: 'FROBNICATE\n' });
  assert.equal(c.code, 400);
  assert.match(String((c.body as { error: string }).error), /line 1/);
});

test('unknown environment → 400 fail-closed', async () => {
  const c = await run({ text: 'GET http://127.0.0.1:9/\n', environment: 'staging' });
  assert.equal(c.code, 400);
  assert.match(String((c.body as { error: string }).error), /unknown environment/);
});

test('missing text → 400', async () => {
  const c = await run({});
  assert.equal(c.code, 400);
});

test('egress default-deny blocks an external host (real gate, nothing dialed)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'httpclient-egress-test-'));
  writeFileSync(join(dataDir, 'egress.json'), JSON.stringify({ enabled: true, defaultPolicy: 'deny', rules: [] }), 'utf8');
  const prev = process.env.AI_FACTORY_DATA_DIR;
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  resetEgressStoreForTests();
  try {
    const c = await run({ text: 'GET http://blocked.invalid/x\n> status == 200\n' });
    assert.equal(c.code, 200);
    const body = c.body as {
      results: Array<{ blocked?: boolean; blockedReason?: string; ok: boolean; assertions: unknown[] }>;
    };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].blocked, true);
    assert.match(String(body.results[0].blockedReason), /egress blocked/);
    assert.ok(!body.results[0].ok);
    assert.equal(body.results[0].assertions.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AI_FACTORY_DATA_DIR;
    else process.env.AI_FACTORY_DATA_DIR = prev;
    resetEgressStoreForTests();
  }
});

test('loopback stays allowed even under default-deny (RFC 8252 carve-out)', async () => {
  const { server, base } = await fixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'httpclient-egress-test-'));
  writeFileSync(join(dataDir, 'egress.json'), JSON.stringify({ enabled: true, defaultPolicy: 'deny', rules: [] }), 'utf8');
  const prev = process.env.AI_FACTORY_DATA_DIR;
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  resetEgressStoreForTests();
  try {
    const c = await run({ text: `GET ${base}/api/health\n> status == 200\n` });
    assert.equal(c.code, 200);
    const body = c.body as { results: Array<{ ok: boolean; blocked?: boolean }> };
    assert.ok(body.results[0].ok);
    assert.ok(!body.results[0].blocked);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.AI_FACTORY_DATA_DIR;
    else process.env.AI_FACTORY_DATA_DIR = prev;
    resetEgressStoreForTests();
  }
});

test('environments file roundtrip (PUT then GET)', async () => {
  const put = async (body: unknown) => {
    const { ctx, calls } = mockCtx(body);
    const handled = await handleHttpClientRoutes(req('PUT'), res, url('/api/http/environments'), ctx);
    assert.equal(handled, true);
    return calls[0];
  };
  const p = await put({ environments: { dev: { vars: { baseUrl: 'http://dev:1' } } } });
  assert.equal(p.code, 200);
  const { ctx, calls } = mockCtx({});
  const handled = await handleHttpClientRoutes(req('GET'), res, url('/api/http/environments'), ctx);
  assert.equal(handled, true);
  assert.equal(calls[0].code, 200);
  const got = calls[0].body as { environments: Record<string, { vars: Record<string, string> }> };
  assert.deepEqual(got.environments, { dev: { vars: { baseUrl: 'http://dev:1' } } });
});

test('bad environments map → 400', async () => {
  const { ctx, calls } = mockCtx({ environments: { dev: { vars: { x: {} } } } });
  const handled = await handleHttpClientRoutes(req('PUT'), res, url('/api/http/environments'), ctx);
  assert.equal(handled, true);
  assert.equal(calls[0].code, 400);
});

test('non-http paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleHttpClientRoutes(req('GET'), res, url('/api/todos'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});
