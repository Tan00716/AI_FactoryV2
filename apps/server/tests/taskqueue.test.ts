/**
 * Background task queue route tests (round-6 task R6-S4) — imports the
 * route from src with type-stripping (dual-mode rule: no src-relative
 * value imports inside the route itself). The exec safety policy is
 * stubbed (allowlist echo/node mirror); policy correctness is
 * routes/exec.ts's tested responsibility — these tests verify the queue
 * HONORS the injected policy (deny → task 'denied', never runs) and
 * that cancel really kills the process group (marker-file zombie check).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/taskqueue.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  handleTaskQueueRoutes,
  resetTaskQueueForTest,
  setTaskQueueDeps,
  type TaskQueueDeps,
} from '../src/routes/taskqueue.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { ParseStats, ProblemMatcherDef } from '../src/problem-matchers.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'taskqueue-srv-test-'));
const TASKS_FILE = join(TEST_ROOT, '.ai-factory', 'tasks.json');

const EMPTY_STATS: ParseStats = {
  lines: 0, matchedLines: 0, skippedLines: 0, diagnostics: 0,
  matchers: [], matchRate: 1, truncated: false,
};

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

const deps: TaskQueueDeps = {
  resolveRoot: () => TEST_ROOT,
  checkCommandPolicy: stubPolicy,
  commandHitsControlDir: () => false,
  resolveCwd: (cwd) => cwd ?? TEST_ROOT,
  resolveMatchers: () => [],
  getMatcher: (_pid: string, _name: string): ProblemMatcherDef | null => null,
  parseOutput: () => ({ diagnostics: [], stats: EMPTY_STATS }),
};

setTaskQueueDeps(deps);

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
  const handled = await handleTaskQueueRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true, `expected ${method} ${path} to be handled`);
  assert.equal(calls.length, 1);
  return calls[0]!;
}

async function submit(label: string) {
  const r = await call('POST', '/api/taskqueue/submit', { label });
  assert.equal(r.code, 201, JSON.stringify(r.body));
  return (r.body as { job: { id: string } }).job.id;
}

async function getJob(id: string) {
  const r = await call('GET', `/api/taskqueue/jobs/${id}`);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  return r.body as { job: { status: string; [k: string]: unknown }; tasks: Array<{ status: string }>; diagnostics: unknown[] };
}

async function waitTerminal(id: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getJob(id);
    const status = detail.job.status as string;
    if (status !== 'queued' && status !== 'running') return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not reach terminal state within ${timeoutMs}ms`);
}

async function setConcurrency(n: number) {
  const r = await call('PUT', '/api/taskqueue/config', { maxConcurrency: n });
  assert.equal(r.code, 200, JSON.stringify(r.body));
}

before(() => {
  mkdirSync(join(TEST_ROOT, '.ai-factory'), { recursive: true });
  // Sleep script: node sleep.js <marker-path> <ms> — writes the marker
  // ONLY if it runs to completion (cancel/timeout must leave no marker).
  writeFileSync(
    join(TEST_ROOT, 'sleep.js'),
    `const fs = require('node:fs');\nsetTimeout(() => { fs.writeFileSync(process.argv[2], 'done'); }, Number(process.argv[3] || 600));\n`,
  );
  writeFileSync(
    join(TEST_ROOT, 'fail.js'),
    `process.exit(3);\n`,
  );
  const tasks = {
    version: '2.0.0',
    tasks: [
      { label: 'quick', type: 'shell', command: 'echo quick-marker' },
      { label: 'quick2', type: 'shell', command: 'echo quick2-marker' },
      { label: 'sleeper', type: 'process', command: 'node', args: ['sleep.js', 'sleeper.marker', '600'] },
      { label: 'longsleeper', type: 'process', command: 'node', args: ['sleep.js', 'long.marker', '10000'] },
      { label: 'timeouter', type: 'process', command: 'node', args: ['sleep.js', 'timeout.marker', '5000'], options: { timeoutMs: 300 } },
      { label: 'failer', type: 'process', command: 'node', args: ['fail.js'] },
      { label: 'bad', type: 'shell', command: 'rm -rf /' },
      { label: 'chained', type: 'shell', command: 'echo chained-marker', dependsOn: ['quick'] },
    ],
  };
  writeFileSync(TASKS_FILE, JSON.stringify(tasks));
});

beforeEach(() => {
  resetTaskQueueForTest();
});

test('submit with a missing tasks file is an honest 404', async () => {
  renameSync(TASKS_FILE, `${TASKS_FILE}.bak`);
  try {
    const r = await call('POST', '/api/taskqueue/submit', { label: 'quick' });
    assert.equal(r.code, 404);
  } finally {
    renameSync(`${TASKS_FILE}.bak`, TASKS_FILE);
  }
});

test('submit with an unknown label is a 400 and runs nothing', async () => {
  const r = await call('POST', '/api/taskqueue/submit', { label: 'nope' });
  assert.equal(r.code, 400);
  const list = await call('GET', '/api/taskqueue/jobs');
  assert.equal((list.body as { jobs: unknown[] }).jobs.length, 0);
});

test('a quick job succeeds and its log holds its own output', async () => {
  const id = await submit('quick');
  assert.equal(await waitTerminal(id), 'succeeded');
  const detail = await getJob(id);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0]?.status, 'ok');
  const log = await call('GET', `/api/taskqueue/jobs/${id}/log`);
  assert.match((log.body as { log: string }).log, /quick-marker/);
  assert.equal((log.body as { truncated: boolean }).truncated, false);
});

test('a chained job runs dependencies first (topological order)', async () => {
  const id = await submit('chained');
  assert.equal(await waitTerminal(id), 'succeeded');
  const detail = await getJob(id);
  assert.deepEqual(detail.tasks.map((t) => t.status), ['ok', 'ok']);
});

test('a denied command fails the job without running', async () => {
  const id = await submit('bad');
  assert.equal(await waitTerminal(id), 'failed');
  const detail = await getJob(id);
  assert.equal(detail.tasks[0]?.status, 'denied');
});

test('a failing task fails the job fail-closed', async () => {
  const id = await submit('failer');
  assert.equal(await waitTerminal(id), 'failed');
  const detail = await getJob(id);
  assert.equal(detail.tasks[0]?.status, 'failed');
});

test('a task that exceeds its timeout is killed and reported as timeout', async () => {
  const id = await submit('timeouter');
  assert.equal(await waitTerminal(id), 'failed');
  const detail = await getJob(id);
  assert.equal(detail.tasks[0]?.status, 'timeout');
  assert.equal(existsSync(join(TEST_ROOT, 'timeout.marker')), false);
});

test('concurrency cap queues FIFO: 3 sleepers at cap 1 run serially', async () => {
  await setConcurrency(1);
  const ids = [await submit('sleeper'), await submit('sleeper'), await submit('sleeper')];
  const list = await call('GET', '/api/taskqueue/jobs');
  const jobs = (list.body as { jobs: Array<{ status: string }> }).jobs;
  assert.equal(jobs.filter((j) => j.status === 'running').length, 1);
  assert.equal(jobs.filter((j) => j.status === 'queued').length, 2);
  for (const id of ids) assert.equal(await waitTerminal(id, 10000), 'succeeded');
});

test('3 sleepers at cap 3 finish in parallel time, not serial sum', async () => {
  await setConcurrency(3);
  const t0 = Date.now();
  const ids = [await submit('sleeper'), await submit('sleeper'), await submit('sleeper')];
  for (const id of ids) assert.equal(await waitTerminal(id, 15000), 'succeeded');
  const elapsed = Date.now() - t0;
  // Load-robust assertion: wall time must be near the LONGEST single
  // task, not the SUM of all three. (Absolute thresholds are meaningless
  // on this VM: 3 parallel 600ms node sleeps take ~1.6s wall here.)
  let sumDurations = 0;
  for (const id of ids) {
    const detail = await getJob(id);
    for (const t of detail.tasks) sumDurations += t.durationMs;
  }
  assert.ok(sumDurations > 0, 'expected recorded task durations');
  assert.ok(
    elapsed < sumDurations * 0.7,
    `expected parallel wall ${elapsed}ms < 0.7 * sum-of-durations ${sumDurations}ms`,
  );
});

test('cancel of a running job kills the process group: no marker file', async () => {
  await setConcurrency(2);
  const id = await submit('longsleeper');
  // Wait until it is actually running before cancelling.
  const deadline = Date.now() + 3000;
  while ((await getJob(id)).job.status !== 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await call('POST', `/api/taskqueue/jobs/${id}/cancel`, {});
  assert.equal(r.code, 200);
  assert.equal((r.body as { result: string }).result, 'cancel-requested');
  assert.equal(await waitTerminal(id), 'cancelled');
  assert.equal(existsSync(join(TEST_ROOT, 'long.marker')), false);
  // Zombie check: the marker must stay absent well past kill time.
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(existsSync(join(TEST_ROOT, 'long.marker')), false);
});

test('cancel of a queued job is immediate and it never runs', async () => {
  await setConcurrency(1);
  const first = await submit('longsleeper');
  const second = await submit('quick');
  const r = await call('POST', `/api/taskqueue/jobs/${second}/cancel`, {});
  assert.equal(r.code, 200);
  assert.equal((r.body as { result: string }).result, 'cancelled');
  const detail = await getJob(second);
  assert.equal(detail.job.status, 'cancelled');
  assert.equal(detail.tasks.length, 0);
  // Clean up the first job so no child survives the test run.
  await call('POST', `/api/taskqueue/jobs/${first}/cancel`, {});
  assert.equal(await waitTerminal(first), 'cancelled');
});

test('two jobs keep their outputs isolated (no cross-talk)', async () => {
  await setConcurrency(2);
  const a = await submit('quick');
  const b = await submit('quick2');
  assert.equal(await waitTerminal(a), 'succeeded');
  assert.equal(await waitTerminal(b), 'succeeded');
  const logA = (await call('GET', `/api/taskqueue/jobs/${a}/log`)).body as { log: string };
  const logB = (await call('GET', `/api/taskqueue/jobs/${b}/log`)).body as { log: string };
  assert.match(logA.log, /quick-marker/);
  assert.doesNotMatch(logA.log, /quick2-marker/);
  assert.match(logB.log, /quick2-marker/);
  assert.doesNotMatch(logB.log, /quick-marker/);
});

test('config validation rejects out-of-range concurrency', async () => {
  const bad0 = await call('PUT', '/api/taskqueue/config', { maxConcurrency: 0 });
  assert.equal(bad0.code, 400);
  const bad33 = await call('PUT', '/api/taskqueue/config', { maxConcurrency: 33 });
  assert.equal(bad33.code, 400);
  const ok = await call('PUT', '/api/taskqueue/config', { maxConcurrency: 2 });
  assert.equal(ok.code, 200);
  assert.equal((ok.body as { maxConcurrency: number }).maxConcurrency, 2);
});

test('unknown job ids are honest 404s', async () => {
  const g = await call('GET', '/api/taskqueue/jobs/tq-99999');
  assert.equal(g.code, 404);
  const c = await call('POST', '/api/taskqueue/jobs/tq-99999/cancel', {});
  assert.equal(c.code, 404);
  const l = await call('GET', '/api/taskqueue/jobs/tq-99999/log');
  assert.equal(l.code, 404);
});
