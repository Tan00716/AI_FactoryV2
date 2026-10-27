/**
 * R6-S5 task-runner schedules — extends the pre-existing scheduler.
 *
 *   - 'task-runner' jobs run a declarative tasks.json chain via the
 *     injected runTaskChain dep (same policy as POST /api/tasks/run)
 *   - 'once' kind fires exactly once, then parks itself (paused, no slot)
 *   - overlap: a slot that fires while the previous run is still in
 *     progress is recorded as skipped, never queued
 *   - execution records: recentRuns ring (max 50) + runs endpoint shape
 *   - boot(): a past-due one-time schedule is marked missed, not fired
 *
 * scheduler.ts is pure (node builtins + @ai-factory/security only), so
 * this file imports it straight from src — no dist needed.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/scheduler-taskrunner.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScheduleStore,
  TaskScheduler,
  type SchedulerDeps,
} from '../src/scheduler.ts';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sched-tr-test-')), 'schedules.json');
}

interface AuditRec {
  actor: string;
  event: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

function makeDeps(
  path: string,
  overrides: Partial<SchedulerDeps> = {},
): { deps: SchedulerDeps; audits: AuditRec[]; chainCalls: Array<{ label: string; root?: string; projectId?: string }> } {
  const audits: AuditRec[] = [];
  const chainCalls: Array<{ label: string; root?: string; projectId?: string }> = [];
  const deps: SchedulerDeps = {
    store: new ScheduleStore(path),
    audit: {
      record: (actor, event, entityType, entityId, details) => {
        audits.push({ actor, event, entityType, entityId, details });
      },
    },
    createTask: () => ({ id: 'task-stub' }),
    startRun: async () => ({ runId: 'run-stub' }),
    runBackup: () => ({ backupId: 'backup-stub' }),
    fetchWebhook: async () => ({ status: 200, body: 'ok' }),
    runTaskChain: async (label, root, projectId) => {
      chainCalls.push({ label, root, projectId });
      return { ok: true, summary: `chain "${label}" ok` };
    },
    ...overrides,
  };
  return { deps, audits, chainCalls };
}

test('task-runner job fires through runTaskChain and records ok', async () => {
  const { deps, chainCalls } = makeDeps(tmpPath());
  const store = deps.store;
  const s = store.create({
    name: 'nightly tests',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'test', root: '/proj' },
  });
  const sched = new TaskScheduler(deps);
  const at = new Date(new Date(s.nextRunAt!).getTime() + 1000);
  await sched.tick(at);
  assert.equal(chainCalls.length, 1);
  assert.equal(chainCalls[0]!.label, 'test');
  assert.equal(chainCalls[0]!.root, '/proj');
  const after = store.get(s.id)!;
  assert.equal(after.runCount, 1);
  assert.equal(after.lastStatus, 'ok');
  assert.equal(after.recentRuns.length, 1);
  assert.equal(after.recentRuns[0]!.ok, true);
  assert.equal(after.recentRuns[0]!.skipped, false);
  assert.equal(after.recentRuns[0]!.trigger, 'tick');
});

test('task-runner failure is recorded and the slot still advances', async () => {
  const { deps } = makeDeps(tmpPath(), {
    runTaskChain: async () => ({ ok: false, summary: 'chain stopped at "build"' }),
  });
  const store = deps.store;
  const s = store.create({
    name: 'bad chain',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'nope' },
  });
  const sched = new TaskScheduler(deps);
  const before = s.nextRunAt!;
  await sched.tick(new Date(new Date(s.nextRunAt!).getTime() + 1000));
  const after = store.get(s.id)!;
  assert.equal(after.lastStatus, 'failed');
  assert.match(after.lastError ?? '', /stopped at/);
  assert.ok(new Date(after.nextRunAt!).getTime() > new Date(before).getTime());
});

test('unwired task-runner job fails closed, never executes', async () => {
  const { deps } = makeDeps(tmpPath(), { runTaskChain: undefined });
  const store = deps.store;
  const s = store.create({
    name: 'unwired',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'test' },
  });
  const sched = new TaskScheduler(deps);
  await sched.tick(new Date(new Date(s.nextRunAt!).getTime() + 1000));
  const after = store.get(s.id)!;
  assert.equal(after.lastStatus, 'failed');
  assert.match(after.lastError ?? '', /not wired/);
});

test('once schedule fires exactly once then parks itself', async () => {
  const { deps, chainCalls } = makeDeps(tmpPath());
  const store = deps.store;
  const runAt = new Date(Date.now() + 60_000).toISOString();
  const s = store.create({
    name: 'one shot',
    kind: 'once',
    runAt,
    job: { type: 'task-runner', label: 'test' },
  });
  assert.equal(s.nextRunAt, new Date(runAt).toISOString());
  const sched = new TaskScheduler(deps);
  await sched.tick(new Date(runAt));
  assert.equal(chainCalls.length, 1);
  const after = store.get(s.id)!;
  assert.equal(after.status, 'paused');
  assert.equal(after.nextRunAt, null);
  await sched.tick(new Date(Date.now() + 3600_000));
  assert.equal(chainCalls.length, 1);
});

test('once schedule in the past is rejected at create', () => {
  const { deps } = makeDeps(tmpPath());
  assert.throws(
    () =>
      deps.store.create({
        name: 'past',
        kind: 'once',
        runAt: new Date(Date.now() - 1000).toISOString(),
        job: { type: 'task-runner', label: 'test' },
      }),
    /must be in the future/,
  );
  assert.throws(
    () =>
      deps.store.create({
        name: 'bad label',
        kind: 'interval',
        intervalMs: 60_000,
        job: { type: 'task-runner', label: '  ' },
      }),
    /requires a label/,
  );
});

test('overlap: second firing while running is recorded as skipped', async () => {
  let release!: () => void;
  const gate = new Promise<{ ok: boolean; summary: string }>((resolve) => {
    release = () => resolve({ ok: true, summary: 'slow chain ok' });
  });
  const { deps, audits } = makeDeps(tmpPath(), {
    runTaskChain: () => gate,
  });
  const store = deps.store;
  const s = store.create({
    name: 'slow',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'slow-task' },
  });
  const sched = new TaskScheduler(deps);
  const t0 = new Date(new Date(s.nextRunAt!).getTime() + 1000);
  const first = sched.tick(t0);
  // Second tick while the first chain is still running.
  await sched.tick(new Date(t0.getTime() + 5000));
  const mid = store.get(s.id)!;
  assert.equal(mid.recentRuns.length, 1);
  assert.equal(mid.recentRuns[0]!.skipped, true);
  assert.equal(mid.runCount, 0);
  assert.ok(audits.some((a) => a.event === 'SCHEDULE_SKIPPED'));
  release();
  await first;
  const after = store.get(s.id)!;
  assert.equal(after.runCount, 1);
  assert.equal(after.recentRuns.length, 2);
  assert.equal(after.recentRuns[1]!.ok, true);
  assert.equal(after.recentRuns[1]!.skipped, false);
});

test('manual trigger while running is also skipped, not queued', async () => {
  let release!: () => void;
  const gate = new Promise<{ ok: boolean; summary: string }>((resolve) => {
    release = () => resolve({ ok: true, summary: 'done' });
  });
  const { deps } = makeDeps(tmpPath(), { runTaskChain: () => gate });
  const store = deps.store;
  const s = store.create({
    name: 'manual-slow',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'slow-task' },
  });
  const sched = new TaskScheduler(deps);
  const first = sched.trigger(s.id);
  const skipped = await sched.trigger(s.id);
  assert.equal(skipped.ok, false);
  assert.match(skipped.summary, /still in progress/);
  release();
  const result = await first;
  assert.equal(result.ok, true);
  const after = store.get(s.id)!;
  assert.equal(after.runCount, 1);
  assert.ok(after.recentRuns.some((r) => r.skipped && r.trigger === 'manual'));
});

test('recentRuns ring caps at 50', async () => {
  const { deps } = makeDeps(tmpPath());
  const store = deps.store;
  const s = store.create({
    name: 'chatty',
    kind: 'interval',
    intervalMs: 60_000,
    job: { type: 'task-runner', label: 'test' },
  });
  const sched = new TaskScheduler(deps);
  for (let i = 0; i < 55; i++) {
    await sched.trigger(s.id);
  }
  const after = store.get(s.id)!;
  assert.equal(after.recentRuns.length, 50);
  assert.equal(after.runCount, 55);
});

test('boot() marks a past-due once schedule missed, never fires it', async () => {
  const path = tmpPath();
  const { deps, chainCalls } = makeDeps(path);
  const runAt = new Date(Date.now() + 60_000).toISOString();
  const s = deps.store.create({
    name: 'once-missed',
    kind: 'once',
    runAt,
    job: { type: 'task-runner', label: 'test' },
  });
  // Simulate a restart after the slot passed: fresh store + scheduler
  // with a clock past the one-time slot.
  const { deps: deps2, audits } = makeDeps(path, {
    now: () => new Date(new Date(runAt).getTime() + 5000),
  });
  const sched2 = new TaskScheduler(deps2);
  sched2.boot();
  const after = deps2.store.get(s.id)!;
  assert.equal(chainCalls.length, 0);
  assert.equal(after.status, 'paused');
  assert.equal(after.nextRunAt, null);
  assert.ok(after.recentRuns.some((r) => r.summary.includes('missed')));
  assert.ok(audits.some((a) => a.event === 'SCHEDULE_MISSED'));
});
