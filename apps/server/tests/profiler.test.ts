/**
 * Profiler route tests (round-4 task R4-A7) — imports
 * ../src/routes/profiler.ts straight from src under node's type-stripping
 * ESM loader. The module is node builtins only (+ @ai-factory/profiler
 * dist), so it resolves (dual-mode import rule in AGENTS.md).
 *
 * Covers: path non-match, validation (400), jail refusal (403),
 * not-found (404), cpu capture end-to-end (real V8 sampling finds the
 * hotspot in the fixture), heap capture end-to-end (real snapshot finds
 * the retained fixture class), and audit records.
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/profiler.test.ts
 * from the repo root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleProfilerRoutes,
  setProfilerInspectionRootResolver,
} from '../src/routes/profiler.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'profiler-srv-test-'));

const HOT_FIXTURE = `function hotLoop(iterations) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += Math.sqrt(i) * Math.sin(i);
  return acc;
}
const t0 = Date.now();
let total = 0;
while (Date.now() - t0 < 1200) total += hotLoop(200000);
`;

const ALLOC_FIXTURE = `class ProfWidget {
  constructor(i) { this.id = i; this.payload = 'y'.repeat(32); }
}
const keep = [];
for (let i = 0; i < 20000; i++) keep.push(new ProfWidget(i));
globalThis.__keep = keep;
`;

writeFileSync(join(TEST_ROOT, 'hot.js'), HOT_FIXTURE, 'utf8');
writeFileSync(join(TEST_ROOT, 'alloc.js'), ALLOC_FIXTURE, 'utf8');
writeFileSync(join(TEST_ROOT, 'note.txt'), 'not js', 'utf8');

setProfilerInspectionRootResolver(() => TEST_ROOT);

function mockCtx(body: unknown): {
  ctx: RouteContext;
  calls: Array<{ code: number; body: unknown }>;
  audits: string[];
} {
  const calls: Array<{ code: number; body: unknown }> = [];
  const audits: string[] = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body,
    audit: { record: (_a: unknown, action: string) => { audits.push(action); } },
  } as unknown as RouteContext;
  return { ctx, calls, audits };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function post(path: string, body: unknown) {
  const { ctx, calls, audits } = mockCtx(body);
  const handled = await handleProfilerRoutes(req('POST'), res, url(path), ctx);
  assert.equal(handled, true);
  return { call: calls[0], audits };
}

test('non-profiler paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleProfilerRoutes(req('POST'), res, url('/api/flaky'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test('cpu: missing script -> 400', async () => {
  const { call } = await post('/api/profiler/cpu', {});
  assert.equal(call.code, 400);
});

test('cpu: jail escape -> 403', async () => {
  const { call } = await post('/api/profiler/cpu', { script: '../../evil.js' });
  assert.equal(call.code, 403);
  assert.equal((call.body as { code: string }).code, 'jail');
});

test('cpu: missing file -> 404', async () => {
  const { call } = await post('/api/profiler/cpu', { script: 'nope.js' });
  assert.equal(call.code, 404);
});

test('cpu: non-js file -> 400', async () => {
  const { call } = await post('/api/profiler/cpu', { script: 'note.txt' });
  assert.equal(call.code, 400);
});

test('cpu: real V8 sampling finds the fixture hotspot', async () => {
  const { call, audits } = await post('/api/profiler/cpu', { script: 'hot.js' });
  assert.equal(call.code, 200);
  const body = call.body as {
    sampleCount: number;
    totalUs: number;
    durationMs: number;
    hotspots: Array<{ functionName: string; selfPct: number }>;
    flame: { value: number; children: unknown[] };
  };
  assert.ok(body.sampleCount > 5, `expected samples, got ${body.sampleCount}`);
  assert.ok(body.durationMs > 0, 'duration must be measured');
  const names = body.hotspots.slice(0, 3).map((h) => h.functionName);
  assert.ok(names.includes('hotLoop'), `hotLoop in top-3, got ${names.join(', ')}`);
  assert.ok(body.flame.value > 0 && body.flame.children.length > 0, 'flame tree must be real');
  assert.ok(audits.includes('PROFILER_CPU_CAPTURED'), 'audit record expected');
});

test('heap: real snapshot finds the retained fixture class', async () => {
  const { call, audits } = await post('/api/profiler/heap', { script: 'alloc.js' });
  assert.equal(call.code, 200);
  const body = call.body as {
    totalBytes: number;
    nodeCount: number;
    durationMs: number;
    top: Array<{ constructor: string; count: number }>;
  };
  assert.ok(body.totalBytes > 0, 'heap must have bytes');
  assert.ok(body.nodeCount > 20000, `expected many nodes, got ${body.nodeCount}`);
  const w = body.top.find((t) => t.constructor === 'ProfWidget');
  assert.ok(w, `ProfWidget in top-10, got ${body.top.map((t) => t.constructor).join(', ')}`);
  assert.ok(w.count >= 15000, `expected ~20000 retained, got ${w.count}`);
  assert.ok(audits.includes('PROFILER_HEAP_CAPTURED'), 'audit record expected');
});

test('heap: jail escape -> 403', async () => {
  const { call } = await post('/api/profiler/heap', { script: '../x.js' });
  assert.equal(call.code, 403);
});
