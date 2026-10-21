/**
 * Mutation-testing route tests (round-3 task R3-T2) — imports
 * ../src/routes/mutation.ts straight from src under node's type-stripping
 * ESM loader. The module is node builtins only (+ @ai-factory/mutation
 * dist + ../inspections, all import-safe), so it resolves (dual-mode
 * import rule in AGENTS.md).
 *
 * Covers: path non-match, input validation (400s), jail refusal,
 * gate-linkage advisory with no report, and one real end-to-end sampled
 * run against the calc fixture (tiny: 3 mutants).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/mutation.test.ts
 * from the repo root (inspection root defaults to process.cwd()).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleMutationRoutes,
  loadLatestMutationReport,
  runMutationGateLinkage,
  setMutationInspectionRootResolver,
} from '../src/routes/mutation.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_TMP_PREFIX = 'mutation-srv-test-';
// Test inspection root = the repo root (mirrors resolveInspectionRoot's
// jail, rooted here instead of the server's cwd).
const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

setMutationInspectionRootResolver((root?: string) => {
  const candidate = root && root.trim() ? resolve(root.trim()) : TEST_ROOT;
  if (candidate !== TEST_ROOT && !candidate.startsWith(TEST_ROOT + sep)) {
    throw new Error(`inspection root is outside the allowed roots: ${candidate}`);
  }
  return candidate;
});

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body,
    audit: { record: () => {} },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

test('non-mutation paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleMutationRoutes(req('GET'), res, url('/api/flaky'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test('POST /api/mutation/run validation', async (t) => {
  await t.test('missing projectId → 400', async () => {
    const { ctx, calls } = mockCtx({ files: ['a.ts'], testFiles: ['a.test.ts'] });
    const handled = await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0].code, 400);
  });

  await t.test('path escape → 400', async () => {
    const { ctx, calls } = mockCtx({
      projectId: 'p1',
      files: ['../../etc/passwd'],
      testFiles: ['a.test.ts'],
    });
    await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
    assert.equal(calls[0].code, 400);
    assert.match(String((calls[0].body as { error: string }).error), /escapes/);
  });

  await t.test('missing file → 400', async () => {
    const { ctx, calls } = mockCtx({
      projectId: 'p1',
      files: ['packages/mutation/src/does-not-exist.ts'],
      testFiles: ['a.test.ts'],
    });
    await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
    assert.equal(calls[0].code, 400);
  });

  await t.test('non-JS/TS file → 400', async () => {
    const { ctx, calls } = mockCtx({
      projectId: 'p1',
      files: ['package.json'],
      testFiles: ['a.test.ts'],
    });
    await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
    assert.equal(calls[0].code, 400);
  });

  await t.test('maxMutants over cap → 400', async () => {
    const { ctx, calls } = mockCtx({
      projectId: 'p1',
      files: ['packages/mutation/src/rng.ts'],
      testFiles: ['packages/mutation/tests/fixtures/calc/calc.test.ts'],
      maxMutants: 99999,
    });
    await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
    assert.equal(calls[0].code, 400);
  });
});

test('GET /api/mutation/latest with no report → null', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleMutationRoutes(req('GET'), res, url('/api/mutation/latest?projectId=no-such-project-xyz'), ctx);
  assert.equal(handled, true);
  assert.equal(calls[0].code, 200);
  assert.equal((calls[0].body as { report: unknown }).report, null);
});

test('gate linkage with no report is advisory and never throws', async () => {
  const { ctx } = mockCtx({});
  const out = await runMutationGateLinkage({ ctx, projectId: 'no-such-project-xyz', actor: 'test' });
  assert.equal(out['attempted'], false);
  assert.ok(typeof out['reason'] === 'string');
});

test('end-to-end sampled run on the calc fixture', async (t) => {
  // Isolate the data dir so the repo's data/ is untouched.
  const dataDir = mkdtempSync(join(tmpdir(), TEST_TMP_PREFIX));
  const prev = process.env.AI_FACTORY_DATA_DIR;
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  t.after(() => {
    if (prev === undefined) delete process.env.AI_FACTORY_DATA_DIR;
    else process.env.AI_FACTORY_DATA_DIR = prev;
  });

  const projectId = 'mutation-e2e-probe';
  const { ctx, calls } = mockCtx({
    projectId,
    files: ['packages/mutation/tests/fixtures/calc/calc.ts'],
    testFiles: ['packages/mutation/tests/fixtures/calc/calc.test.ts'],
    seed: 20261021,
    maxMutants: 3,
    perFileCap: 3,
    timeoutMs: 20000,
    maxTotalMs: 120000,
  });
  const handled = await handleMutationRoutes(req('POST'), res, url('/api/mutation/run'), ctx);
  assert.equal(handled, true);
  assert.equal(calls[0].code, 202);
  const accepted = calls[0].body as { runId: string; status: string; generated: number; sampled: number };
  assert.equal(accepted.status, 'running');
  assert.equal(accepted.sampled, 3);
  assert.ok(accepted.generated >= 3);

  // Poll until the background run finishes.
  const deadline = Date.now() + 90000;
  let status: { status: string; report: { totals: Record<string, number | null> } | null } | null = null;
  for (;;) {
    const { ctx: c2, calls: calls2 } = mockCtx({});
    await handleMutationRoutes(req('GET'), res, url(`/api/mutation/runs/${accepted.runId}`), c2);
    assert.equal(calls2[0].code, 200);
    status = calls2[0].body as typeof status;
    if (status && status.status !== 'running') break;
    if (Date.now() > deadline) throw new Error('mutation run did not finish in time');
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.equal(status!.status, 'done');
  const totals = status!.report!.totals;
  assert.equal(totals.sampled, 3);
  assert.ok(totals.killed! + totals.survived! + totals.timeout! + totals.invalid! === 3);

  // Latest report is persisted and loadable.
  const latest = loadLatestMutationReport(projectId);
  assert.ok(latest);
  assert.equal(latest!.runId, accepted.runId);

  // Gate linkage now reports the score (advisory, never blocking).
  const { ctx: c3 } = mockCtx({});
  const link = await runMutationGateLinkage({ ctx: c3, projectId, actor: 'test' });
  assert.equal(link['attempted'], true);
  assert.equal(link['advisory'], true);
  assert.equal(link['blocks'], false);
});
