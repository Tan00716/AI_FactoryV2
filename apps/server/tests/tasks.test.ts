/**
 * Task runner route tests (round-5 task R5-S2) — imports the route from
 * src with type-stripping (dual-mode rule: no src-relative value imports
 * inside the route itself). The exec safety policy is stubbed (an
 * allowlist echo/node mirror); policy correctness is routes/exec.ts's
 * tested responsibility — these tests verify the route HONORS the
 * injected policy (deny → 'denied', never runs).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/tasks.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleTaskRunnerRoutes,
  resetTaskRunRecords,
  setTaskRunnerDeps,
  type TaskRunnerDeps,
} from '../src/routes/tasks.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { ParseStats, ProblemMatcherDef } from '../src/problem-matchers.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'tasks-srv-test-'));

const EMPTY_STATS: ParseStats = {
  lines: 0, matchedLines: 0, skippedLines: 0, diagnostics: 0,
  matchers: [], matchRate: 1, truncated: false,
};

/** Stub exec policy: allowlist echo/node only, deny rm-shaped commands. */
function stubPolicy(command: string): string[] {
  if (/(^|\s)rm(\s|$)/.test(command)) {
    const e = new Error('command refused: blocked by the execution safety policy');
    e.name = 'ExecPolicyDenied';
    throw e;
  }
  const tokens = command.trim().split(/\s+/);
  if (!['echo', 'node'].includes(tokens[0])) {
    const e = new Error(`command refused: '${tokens[0]}' is not in the allowed command list`);
    e.name = 'ExecPolicyDenied';
    throw e;
  }
  return tokens;
}

const deps: TaskRunnerDeps = {
  resolveRoot: () => TEST_ROOT,
  checkCommandPolicy: stubPolicy,
  commandHitsControlDir: () => false,
  resolveCwd: (cwd) => cwd ?? TEST_ROOT,
  parseAndStore: () => ({ added: 0, total: 0, stats: EMPTY_STATS }),
  resolveMatchers: () => [],
  getMatcher: (_pid: string, _name: string): ProblemMatcherDef | null => null,
};

setTaskRunnerDeps(deps);
beforeEach(() => resetTaskRunRecords());

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

async function call(method: string, path: string, body?: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleTaskRunnerRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  return calls[0];
}

const VALID_TASKS = JSON.stringify({
  version: '2.0.0',
  tasks: [
    { label: 'hello', command: 'echo hello' },
    { label: 'chain', command: 'echo chained', dependsOn: ['hello'] },
    { label: 'boom', command: 'node -e process.exit(3)' },
    { label: 'after-boom', command: 'echo never', dependsOn: ['boom'] },
    { label: 'evil', command: 'rm -rf /' },
    { label: 'diamond-top', command: 'echo top', dependsOn: ['diamond-b', 'diamond-c'], dependsOrder: 'parallel' },
    { label: 'diamond-b', command: 'echo b', dependsOn: ['diamond-base'] },
    { label: 'diamond-c', command: 'echo c', dependsOn: ['diamond-base'] },
    { label: 'diamond-base', command: 'echo base' },
  ],
});

test('GET with no tasks file reports missing honestly', async () => {
  const c = await call('GET', '/api/tasks/list');
  assert.equal(c.code, 200);
  assert.equal((c.body as { missing: boolean }).missing, true);
});

test('GET /api/tasks (bare or ?projectId=) falls through to the legacy project-tasks endpoint', async () => {
  // R5 closeout regression: the runner claimed GET /api/tasks before the
  // legacy handler in the dispatch chain, so the desktop's project task
  // list received the runner's {tasks,errors,warnings,missing} shape and
  // the whole app crashed in the error boundary (e2e 0/7). The runner's
  // list now lives at /api/tasks/list; bare GET /api/tasks is legacy.
  const { ctx } = mockCtx(null);
  for (const p of ['/api/tasks', '/api/tasks?projectId=abc']) {
    const handled = await handleTaskRunnerRoutes(req('GET'), res, url(p), ctx);
    assert.equal(handled, false, p);
  }
  const listed = await handleTaskRunnerRoutes(req('GET'), res, url('/api/tasks/list'), ctx);
  assert.equal(listed, true);
});

test('PUT validates then writes; GET lists', async () => {
  const put = await call('PUT', '/api/tasks', { text: VALID_TASKS });
  assert.equal(put.code, 200);
  assert.equal((put.body as { count: number }).count, 9);
  const get = await call('GET', '/api/tasks/list');
  assert.equal(get.code, 200);
  const tasks = (get.body as { tasks: Array<{ label: string }> }).tasks;
  assert.equal(tasks.length, 9);
  // written to disk, jailed under root
  const onDisk = readFileSync(join(TEST_ROOT, '.ai-factory', 'tasks.json'), 'utf8');
  assert.ok(onDisk.includes('"hello"'));
});

test('PUT with invalid JSON is a 400 and writes nothing', async () => {
  const put = await call('PUT', '/api/tasks', { text: '{broken' });
  assert.equal(put.code, 400);
  assert.ok(((put.body as { errors: string[] }).errors.length) > 0);
});

test('PUT with validation errors is a 400', async () => {
  const put = await call('PUT', '/api/tasks', {
    text: JSON.stringify({ tasks: [{ label: 'a', command: 'x' }, { label: 'a', command: 'y' }] }),
  });
  assert.equal(put.code, 400);
});

test('run executes a simple task and captures output', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'hello', projectId: 'p1' });
  assert.equal(c.code, 200);
  const body = c.body as { ok: boolean; results: Array<{ status: string; output: string; exitCode: number }> };
  assert.equal(body.ok, true);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].status, 'ok');
  assert.equal(body.results[0].exitCode, 0);
  assert.ok(body.results[0].output.includes('hello'));
});

test('run executes the dependency chain in order', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'chain', projectId: 'p1' });
  const body = c.body as { ok: boolean; results: Array<{ label: string; status: string }> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.results.map((r) => r.label), ['hello', 'chain']);
});

test('a failing dependency stops the chain (fail-closed)', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'after-boom', projectId: 'p1' });
  const body = c.body as {
    ok: boolean; stoppedAt: string | null;
    results: Array<{ label: string; status: string; exitCode: number | null }>;
  };
  assert.equal(body.ok, false);
  assert.equal(body.stoppedAt, 'after-boom');
  // 'after-boom' itself never ran: only the failed dependency is recorded.
  assert.deepEqual(body.results.map((r) => r.label), ['boom']);
  const boom = body.results[0];
  assert.equal(boom.status, 'failed');
  assert.equal(boom.exitCode, 3);
});

test('denied command never runs (policy honored)', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'evil', projectId: 'p1' });
  const body = c.body as { ok: boolean; results: Array<{ status: string; error?: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.results[0].status, 'denied');
  assert.ok((body.results[0].error ?? '').includes('refused'));
});

test('diamond dependency runs the shared base exactly once', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'diamond-top', projectId: 'p1' });
  const body = c.body as { ok: boolean; results: Array<{ label: string; status: string }> };
  assert.equal(body.ok, true);
  const labels = body.results.map((r) => r.label);
  assert.equal(labels.filter((l) => l === 'diamond-base').length, 1);
  assert.equal(labels.length, 4);
});

test('cycle is a 400 before anything runs', async () => {
  await call('PUT', '/api/tasks', {
    text: JSON.stringify({ tasks: [
      { label: 'x', command: 'echo x', dependsOn: ['y'] },
      { label: 'y', command: 'echo y', dependsOn: ['x'] },
    ] }),
  });
  const c = await call('POST', '/api/tasks/run', { label: 'x', projectId: 'p1' });
  assert.equal(c.code, 400);
  assert.equal((c.body as { code: string }).code, 'plan-failed');
});

test('unknown label is a 400', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  const c = await call('POST', '/api/tasks/run', { label: 'ghost', projectId: 'p1' });
  assert.equal(c.code, 400);
});

test('options.cwd escaping the root is denied', async () => {
  await call('PUT', '/api/tasks', {
    text: JSON.stringify({ tasks: [{ label: 'esc', command: 'echo hi', options: { cwd: '../../..' } }] }),
  });
  const c = await call('POST', '/api/tasks/run', { label: 'esc', projectId: 'p1' });
  const body = c.body as { ok: boolean; results: Array<{ status: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.results[0].status, 'denied');
});

test('run records are listed', async () => {
  await call('PUT', '/api/tasks', { text: VALID_TASKS });
  await call('POST', '/api/tasks/run', { label: 'hello', projectId: 'p1' });
  const c = await call('GET', '/api/tasks/runs');
  const runs = (c.body as { runs: Array<{ ok: boolean; taskCount: number }> }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ok, true);
  assert.equal(runs[0].taskCount, 1);
});
