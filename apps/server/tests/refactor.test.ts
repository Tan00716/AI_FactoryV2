/**
 * Deterministic-refactoring route tests (round-4 task R4-S3) — imports
 * ../src/routes/refactor.ts straight from src under node's type-stripping
 * ESM loader. The module is node builtins only (+ @ai-factory/refactor
 * dist), so it resolves (dual-mode import rule in AGENTS.md).
 *
 * Covers: path non-match, input validation (400s), jail refusal,
 * analyze → proposal (200, in-memory diff, no writes), apply accept-all
 * (200, file actually changed), per-item reject (skipped), drift guard
 * (409 REFACTOR_DRIFT, nothing written), unknown proposal (404), and
 * GET proposal round-trip.
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/refactor.test.ts
 * from the repo root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleRefactorRoutes,
  setRefactorInspectionRootResolver,
} from '../src/routes/refactor.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'refactor-srv-test-'));

const FIXTURE = `function total(a: number, b: number) {
  return a + b * 2;
}
`;

function resetFixture(): void {
  writeFileSync(join(TEST_ROOT, 'calc.ts'), FIXTURE, 'utf8');
  writeFileSync(join(TEST_ROOT, 'note.txt'), 'not typescript', 'utf8');
}

resetFixture();

setRefactorInspectionRootResolver(() => TEST_ROOT);

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

async function analyze(body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleRefactorRoutes(req('POST'), res, url('/api/refactor/analyze'), ctx);
  assert.equal(handled, true);
  return calls[0];
}

async function apply(body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleRefactorRoutes(req('POST'), res, url('/api/refactor/apply'), ctx);
  assert.equal(handled, true);
  return calls[0];
}

test('non-refactor paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleRefactorRoutes(req('GET'), res, url('/api/flaky'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test('analyze validation', async (t) => {
  await t.test('missing projectId → 400', async () => {
    const c = await analyze({ op: 'extract-variable', file: 'calc.ts' });
    assert.equal(c.code, 400);
  });
  await t.test('bad op → 400', async () => {
    const c = await analyze({ projectId: 'p1', op: 'teleport', file: 'calc.ts' });
    assert.equal(c.code, 400);
  });
  await t.test('path escape → 400', async () => {
    const c = await analyze({ projectId: 'p1', op: 'rename-symbol', file: '../../etc/passwd', offset: 1, newName: 'x' });
    assert.equal(c.code, 400);
    assert.match(String((c.body as { error: string }).error), /escapes/);
  });
  await t.test('missing file → 400', async () => {
    const c = await analyze({ projectId: 'p1', op: 'rename-symbol', file: 'nope.ts', offset: 1, newName: 'x' });
    assert.equal(c.code, 400);
  });
  await t.test('non-TS file → 400', async () => {
    const c = await analyze({ projectId: 'p1', op: 'rename-symbol', file: 'note.txt', offset: 1, newName: 'x' });
    assert.equal(c.code, 400);
  });
  await t.test('missing params → 400', async () => {
    const c = await analyze({ projectId: 'p1', op: 'extract-variable', file: 'calc.ts' });
    assert.equal(c.code, 400);
  });
});

test('analyze extract-variable → proposal with diff, no writes', async () => {
  resetFixture();
  const start = FIXTURE.indexOf('a + b * 2');
  const c = await analyze({
    projectId: 'p1',
    op: 'extract-variable',
    file: 'calc.ts',
    selection: { start, end: start + 9 },
    name: 'sum',
  });
  assert.equal(c.code, 200);
  const body = c.body as { proposalId: string; items: { id: string; file: string; diff: string }[] };
  assert.ok(body.proposalId);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].file, 'calc.ts');
  assert.match(body.items[0].diff, /--- a\/calc\.ts/);
  assert.match(body.items[0].diff, /\+.*const sum = a \+ b \* 2/);
  // analyze is side-effect free
  assert.equal(readFileSync(join(TEST_ROOT, 'calc.ts'), 'utf8'), FIXTURE);
});

test('analyze refuses bad op input → 400 with code', async () => {
  resetFixture();
  const c = await analyze({
    projectId: 'p1',
    op: 'rename-symbol',
    file: 'calc.ts',
    offset: FIXTURE.indexOf('a: number'),
    newName: 'b', // collides with param `b` in the same scope
  });
  assert.equal(c.code, 400);
  assert.equal((c.body as { code: string }).code, 'name-collision');
});

test('apply accept-all changes the file', async () => {
  resetFixture();
  const start = FIXTURE.indexOf('a + b * 2');
  const a = await analyze({
    projectId: 'p1', op: 'extract-variable', file: 'calc.ts',
    selection: { start, end: start + 9 }, name: 'sum',
  });
  const proposal = a.body as { proposalId: string; items: { id: string }[] };
  const ap = await apply({ proposalId: proposal.proposalId, acceptedIds: proposal.items.map((i) => i.id) });
  assert.equal(ap.code, 200);
  const applied = (ap.body as { applied: string[] }).applied;
  assert.deepEqual(applied, ['calc.ts']);
  const after = readFileSync(join(TEST_ROOT, 'calc.ts'), 'utf8');
  assert.ok(after.includes('const sum = a + b * 2;'));
  assert.ok(after.includes('return sum;'));
});

test('apply rejects unknown proposal → 404', async () => {
  const ap = await apply({ proposalId: 'nope', acceptedIds: ['x'] });
  assert.equal(ap.code, 404);
});

test('apply with empty acceptedIds → 400', async () => {
  resetFixture();
  const start = FIXTURE.indexOf('a + b * 2');
  const a = await analyze({
    projectId: 'p1', op: 'extract-variable', file: 'calc.ts',
    selection: { start, end: start + 9 }, name: 'sum',
  });
  const proposal = a.body as { proposalId: string };
  const ap = await apply({ proposalId: proposal.proposalId, acceptedIds: [] });
  assert.equal(ap.code, 400);
});

test('drift guard → 409 and nothing written', async () => {
  resetFixture();
  const start = FIXTURE.indexOf('a + b * 2');
  const a = await analyze({
    projectId: 'p1', op: 'extract-variable', file: 'calc.ts',
    selection: { start, end: start + 9 }, name: 'sum',
  });
  const proposal = a.body as { proposalId: string; items: { id: string }[] };
  // someone edits the file after analyze
  writeFileSync(join(TEST_ROOT, 'calc.ts'), FIXTURE + '// touched\n', 'utf8');
  const ap = await apply({ proposalId: proposal.proposalId, acceptedIds: proposal.items.map((i) => i.id) });
  assert.equal(ap.code, 409);
  assert.equal((ap.body as { code: string }).code, 'REFACTOR_DRIFT');
  // nothing was written by apply: only the external touch remains
  assert.equal(readFileSync(join(TEST_ROOT, 'calc.ts'), 'utf8'), FIXTURE + '// touched\n');
});

test('rename across files: per-item reject leaves other files applied', async () => {
  resetFixture();
  writeFileSync(join(TEST_ROOT, 'a.ts'), 'export function helper() {\n  return 1;\n}\n', 'utf8');
  writeFileSync(join(TEST_ROOT, 'b.ts'), "import { helper } from './a';\nconst v = helper();\n", 'utf8');
  const a = await analyze({
    projectId: 'p1', op: 'rename-symbol', file: 'a.ts',
    offset: 'export function helper() {'.indexOf('helper'),
    newName: 'util',
    otherFiles: ['b.ts'],
  });
  assert.equal(a.code, 200);
  const proposal = a.body as { proposalId: string; items: { id: string; file: string }[] };
  assert.equal(proposal.items.length, 2);
  // accept only a.ts, reject b.ts
  const keep = proposal.items.find((i) => i.file === 'a.ts') as { id: string };
  const ap = await apply({ proposalId: proposal.proposalId, acceptedIds: [keep.id] });
  assert.equal(ap.code, 200);
  const body = ap.body as { applied: string[]; skipped: string[] };
  assert.deepEqual(body.applied, ['a.ts']);
  assert.equal(body.skipped.length, 1);
  assert.ok(readFileSync(join(TEST_ROOT, 'a.ts'), 'utf8').includes('function util()'));
  assert.ok(readFileSync(join(TEST_ROOT, 'b.ts'), 'utf8').includes('helper()'), 'rejected file untouched');
});

test('GET proposal round-trip', async () => {
  resetFixture();
  const start = FIXTURE.indexOf('a + b * 2');
  const a = await analyze({
    projectId: 'p1', op: 'extract-variable', file: 'calc.ts',
    selection: { start, end: start + 9 }, name: 'sum',
  });
  const proposal = a.body as { proposalId: string };
  const { ctx, calls } = mockCtx({});
  const handled = await handleRefactorRoutes(req('GET'), res, url(`/api/refactor/proposals/${proposal.proposalId}`), ctx);
  assert.equal(handled, true);
  assert.equal(calls[0].code, 200);
  assert.equal((calls[0].body as { proposalId: string }).proposalId, proposal.proposalId);

  const { ctx: ctx2, calls: calls2 } = mockCtx({});
  await handleRefactorRoutes(req('GET'), res, url('/api/refactor/proposals/nope'), ctx2);
  assert.equal(calls2[0].code, 404);
});
