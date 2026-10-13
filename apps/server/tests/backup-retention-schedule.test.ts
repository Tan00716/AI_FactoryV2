/**
 * Backup schedules + retention count policy — §47 (Batch 20).
 *
 * Covers:
 *  1. retention_policies keep_count column migration + round-trip
 *  2. backup_schedules store CRUD
 *  3. PUT /api/retention/policies accepts {days, keepCount}; keepCount
 *     rejected for non-backup categories; legacy <days|null> shape
 *     still works
 *  4. cron parsing + next-occurrence computation (UTC)
 *  5. scheduler tick with injected clock: due schedule runs the same
 *     createBackup() path, advances next_run_at
 *  6. boot reconcile: past-due enabled schedules are MISSED (audited,
 *     never backfilled)
 *  7. schedule HTTP surface: create/list/get/patch/delete/manual run,
 *     validation errors
 *  8. legal hold exempts backups from enforce (re-evaluated at enforce
 *     time); release re-arms deletion
 *  9. keepCount enforce: newest N kept, the rest deleted, manifest
 *     listing consistent afterwards
 * 10. a failing scheduled run is recorded 'failed' and its slot still
 *     advances (no retry storm)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import {
  TaskManager,
  WorkflowEngine,
  EvidenceEngine,
  AuditLog,
  AgentRegistry,
} from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';
import { handleRetentionRoutes } from '../src/routes/retention.ts';
import {
  backupDirPath,
  createBackup,
  initBackupService,
  listBackupManifests,
  stagedRestoreBackupId,
} from '../src/routes/backup.ts';
import {
  BackupScheduler,
  computeNextRun,
  handleBackupScheduleRoutes,
  initBackupScheduler,
  MIN_INTERVAL_MS,
  nextCronTime,
  parseCronExpr,
} from '../src/routes/backup-scheduler.ts';
import type { RouteContext } from '../src/routes/context.ts';

const CONFIRM = { confirm: 'DELETE_EXPIRED' };
const OLD_ISO = '2020-01-01T00:00:00.000Z';

function makeWorld(dir: string) {
  const file = join(dir, 'factory.db');
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
  fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
  return { file, fdb, tasks, evidence, audit, agents };
}

function tmpWorld(): { dir: string; world: ReturnType<typeof makeWorld> } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-b20-'));
  const world = makeWorld(dir);
  const backupDir = join(dir, 'backups');
  initBackupService({ dbPath: world.file, backupDir, appVersion: 'test' });
  initBackupScheduler({
    schedules: world.fdb.backupSchedules,
    audit: {
      record: (actor: string, event: string, entityType: string, entityId: string, details?: Record<string, unknown>) =>
        world.audit.record(actor, event, entityType, entityId, details),
    },
    runBackup: () => createBackup(world.fdb, 'scheduled'),
  });
  return { dir, world };
}

function makeCall(world: ReturnType<typeof makeWorld>) {
  return async (
    handler: typeof handleRetentionRoutes | typeof handleBackupScheduleRoutes,
    method: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; body: any }> => {
    const calls: Array<{ status: number; body: unknown }> = [];
    const ctx = {
      tasks: world.tasks,
      evidence: world.evidence,
      audit: world.audit,
      agents: world.agents,
      engine: new WorkflowEngine({
        tasks: world.tasks,
        evidence: world.evidence,
        audit: world.audit,
      }),
      fdb: world.fdb,
      stepIntentStore: world.fdb.stepIntents,
      notify: { emit: () => {} },
      bus: { emit: () => {} },
      backupAccess: {
        dir: backupDirPath,
        list: listBackupManifests,
        stagedRestoreBackupId,
      },
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
      readBody: async () => body,
    } as unknown as RouteContext;
    const handled = await (handler as typeof handleRetentionRoutes)(
      { method } as never,
      {} as never,
      new URL(`http://localhost${path}`),
      ctx,
    );
    assert.equal(handled, true, `${method} ${path} not handled`);
    assert.equal(calls.length, 1);
    return calls[0] as { status: number; body: any };
  };
}

/** Backdate a backup's manifest so it reads as expired. */
function backdateManifest(backupId: string, createdAt: string): void {
  const p = join(backupDirPath(), backupId, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.createdAt = createdAt;
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}

describe('Batch 20 — retention keep_count (§47)', () => {
  it('keep_count column is migrated onto old databases and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-b20-mig-'));
    const file = join(dir, 'factory.db');
    // Simulate a pre-Batch-20 database: full schema, then drop the
    // new column.
    {
      const fdb = new FactoryDatabase(file);
      fdb.db.exec('ALTER TABLE retention_policies DROP COLUMN keep_count');
      fdb.db.close();
    }
    const fdb = new FactoryDatabase(file);
    const cols = (
      fdb.db.prepare('PRAGMA table_info(retention_policies)').all() as { name: string }[]
    ).map((c) => c.name);
    assert.ok(cols.includes('keep_count'), 'keep_count migrated back on');
    const p = fdb.retention.setPolicy('backups', 7, 'human', new Date().toISOString(), 3);
    assert.equal(p.retentionDays, 7);
    assert.equal(p.keepCount, 3);
    const again = fdb.retention.getPolicy('backups');
    assert.equal(again.keepCount, 3);
    fdb.db.close();
  });

  it('PUT policies accepts {days, keepCount}; keepCount rejected elsewhere; legacy shape works', async () => {
    const { world } = tmpWorld();
    const call = makeCall(world);
    const r = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { backups: { days: 7, keepCount: 2 } },
    });
    assert.equal(r.status, 200);
    const backups = r.body.policies.find((p: any) => p.category === 'backups');
    assert.equal(backups.retentionDays, 7);
    assert.equal(backups.keepCount, 2);

    const bad = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { runtime_runs: { days: 30, keepCount: 5 } },
    });
    assert.equal(bad.status, 400);

    const bad2 = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { backups: { days: 7, keepCount: 0 } },
    });
    assert.equal(bad2.status, 400);

    const legacy = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { runtime_runs: 30 },
    });
    assert.equal(legacy.status, 200);
    const runs = legacy.body.policies.find((p: any) => p.category === 'runtime_runs');
    assert.equal(runs.retentionDays, 30);
    assert.equal(runs.keepCount, null);

    const get = await call(handleRetentionRoutes, 'GET', '/api/retention/policies');
    assert.equal(get.status, 200);
    assert.ok(get.body.policies.some((p: any) => p.category === 'backups' && p.keepCount === 2));
  });

  it('keepCount enforce keeps newest N, deletes the rest, manifest listing stays consistent', async () => {
    const { world } = tmpWorld();
    const call = makeCall(world);
    const b1 = createBackup(world.fdb, 'manual');
    const b2 = createBackup(world.fdb, 'manual');
    const b3 = createBackup(world.fdb, 'manual');
    // Force a deterministic age order: b1 oldest, b3 newest.
    backdateManifest(b1.backupId, '2020-01-01T00:00:00.000Z');
    backdateManifest(b2.backupId, '2020-06-01T00:00:00.000Z');
    backdateManifest(b3.backupId, '2021-01-01T00:00:00.000Z');

    await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { backups: { days: null, keepCount: 2 } },
    });
    const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
    assert.equal(ev.status, 200);
    const cat = ev.body.categories.find((c: any) => c.category === 'backups');
    assert.equal(cat.candidates, 1, 'only the oldest is beyond the count');
    assert.equal(cat.keepCount, 2);
    assert.deepEqual(cat.sampleIds, [b1.backupId]);

    const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted.backups, 1);
    assert.ok(!fs.existsSync(join(backupDirPath(), b1.backupId)), 'backup dir deleted');
    const remaining = listBackupManifests().map((m) => m.backupId).sort();
    assert.deepEqual(remaining, [b2.backupId, b3.backupId].sort());
  });

  it('legal hold exempts backups at enforce time; release re-arms deletion', async () => {
    const { world } = tmpWorld();
    const call = makeCall(world);
    const b1 = createBackup(world.fdb, 'manual');
    const b2 = createBackup(world.fdb, 'manual');
    backdateManifest(b1.backupId, OLD_ISO);
    backdateManifest(b2.backupId, OLD_ISO);
    await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
      policies: { backups: 1 },
    });
    const hold = await call(handleRetentionRoutes, 'POST', '/api/retention/holds', {
      scope: 'GLOBAL',
      reason: 'test hold',
    });
    assert.equal(hold.status, 201);

    const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
    const cat = ev.body.categories.find((c: any) => c.category === 'backups');
    assert.equal(cat.candidates, 0);
    assert.equal(cat.heldExempt, 2);

    const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted.backups, 0);
    assert.ok(fs.existsSync(join(backupDirPath(), b1.backupId)), 'held backup survives');

    const rel = await call(
      handleRetentionRoutes,
      'POST',
      `/api/retention/holds/${hold.body.hold.id}/release`,
    );
    assert.equal(rel.status, 200);
    const en2 = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en2.body.deleted.backups, 2);
    assert.equal(listBackupManifests().length, 0);
  });
});

describe('Batch 20 — cron parsing', () => {
  it('parses 5-field expressions and rejects bad ones', () => {
    const c = parseCronExpr('*/15 9 * * 1-5');
    assert.ok(c.minute.has(0) && c.minute.has(15) && c.minute.has(30));
    assert.ok(c.hour.has(9) && !c.hour.has(10));
    assert.ok(c.dow.has(1) && c.dow.has(5) && !c.dow.has(0));
    assert.throws(() => parseCronExpr('0 9 * *'), /5 fields/);
    assert.throws(() => parseCronExpr('61 * * * *'), /out of range/);
    assert.throws(() => parseCronExpr('nope * * * *'), /invalid cron field part/);
  });

  it('nextCronTime finds the next UTC occurrence', () => {
    const after = new Date('2026-10-13T08:00:00.000Z');
    assert.equal(
      nextCronTime('0 9 * * *', after).toISOString(),
      '2026-10-13T09:00:00.000Z',
    );
    // Already past 09:00 → tomorrow.
    assert.equal(
      nextCronTime('0 9 * * *', new Date('2026-10-13T09:00:01.000Z')).toISOString(),
      '2026-10-14T09:00:00.000Z',
    );
    // Every 15 minutes.
    assert.equal(
      nextCronTime('*/15 * * * *', after).toISOString(),
      '2026-10-13T08:15:00.000Z',
    );
  });

  it('computeNextRun honors the interval floor', () => {
    const from = new Date('2026-10-13T08:00:00.000Z');
    assert.equal(
      computeNextRun({ scheduleKind: 'interval', intervalMs: 60000, cronExpr: null }, from).toISOString(),
      '2026-10-13T08:01:00.000Z',
    );
    assert.throws(
      () => computeNextRun({ scheduleKind: 'interval', intervalMs: 1000, cronExpr: null }, from),
      new RegExp(String(MIN_INTERVAL_MS)),
    );
  });
});

describe('Batch 20 — backup scheduler', () => {
  function schedulerWithClock(world: ReturnType<typeof makeWorld>, nowIso: string) {
    let now = new Date(nowIso);
    const sched = new BackupScheduler({
      schedules: world.fdb.backupSchedules,
      audit: {
        record: (actor: string, event: string, entityType: string, entityId: string, details?: Record<string, unknown>) =>
          world.audit.record(actor, event, entityType, entityId, details),
      },
      runBackup: () => createBackup(world.fdb, 'scheduled'),
      now: () => now,
    });
    return { sched, setNow: (iso: string) => { now = new Date(iso); } };
  }

  it('tick runs due schedules through the real backup path and advances next_run_at', () => {
    const { world } = tmpWorld();
    const { sched } = schedulerWithClock(world, '2026-10-13T08:00:00.000Z');
    const s = world.fdb.backupSchedules.create(
      { name: 'hourly', scheduleKind: 'interval', intervalMs: 60000 },
      '2026-10-13T07:59:00.000Z',
      'human',
      '2026-10-13T07:00:00.000Z',
    );
    const before = listBackupManifests().length;
    const { ran, failed } = sched.tick();
    assert.deepEqual(ran, [s.id]);
    assert.deepEqual(failed, []);
    const manifests = listBackupManifests();
    assert.equal(manifests.length, before + 1);
    const created = manifests.find((m) => m.kind === 'scheduled');
    assert.ok(created, 'scheduled backup recorded with kind=scheduled');
    const after = world.fdb.backupSchedules.get(s.id)!;
    assert.equal(after.lastStatus, 'ok');
    assert.ok(after.lastRunAt !== null);
    assert.equal(Date.parse(after.nextRunAt) > Date.parse('2026-10-13T08:00:00.000Z'), true);
    // A second tick at the same instant does nothing (no busy loop).
    const again = sched.tick();
    assert.deepEqual(again.ran, []);
  });

  it('boot marks past-due enabled schedules MISSED, advances the slot, never backfills', () => {
    const { world } = tmpWorld();
    const { sched } = schedulerWithClock(world, '2026-10-13T12:00:00.000Z');
    const due = world.fdb.backupSchedules.create(
      { name: 'nightly', scheduleKind: 'cron', cronExpr: '0 2 * * *' },
      '2026-10-13T02:00:00.000Z',
      'human',
      '2026-10-12T02:00:00.000Z',
    );
    const disabled = world.fdb.backupSchedules.create(
      { name: 'off', scheduleKind: 'interval', intervalMs: 60000, enabled: false },
      '2026-10-13T11:00:00.000Z',
      'human',
      '2026-10-13T10:00:00.000Z',
    );
    const before = listBackupManifests().length;
    const { missed } = sched.boot();
    assert.deepEqual(missed, [due.id]);
    // No backup was created for the missed slot.
    assert.equal(listBackupManifests().length, before);
    const row = world.fdb.backupSchedules.get(due.id)!;
    assert.equal(row.lastStatus, 'MISSED');
    assert.equal(row.nextRunAt, '2026-10-14T02:00:00.000Z');
    // Disabled schedules are left alone, even when past due.
    assert.equal(world.fdb.backupSchedules.get(disabled.id)!.lastStatus, null);
  });

  it('schedule HTTP surface: create/list/get/patch/run/delete + validation', async () => {
    const { world } = tmpWorld();
    const call = makeCall(world);

    const badKind = await call(handleBackupScheduleRoutes, 'POST', '/api/backup/schedules', {
      name: 'x',
      kind: 'whenever',
    });
    assert.equal(badKind.status, 400);

    const badInterval = await call(handleBackupScheduleRoutes, 'POST', '/api/backup/schedules', {
      name: 'x',
      kind: 'interval',
      intervalMs: 1000,
    });
    assert.equal(badInterval.status, 400);

    const badCron = await call(handleBackupScheduleRoutes, 'POST', '/api/backup/schedules', {
      name: 'x',
      kind: 'cron',
      cronExpr: 'not a cron',
    });
    assert.equal(badCron.status, 400);

    const created = await call(handleBackupScheduleRoutes, 'POST', '/api/backup/schedules', {
      name: 'every-minute',
      kind: 'interval',
      intervalMs: 60000,
    });
    assert.equal(created.status, 201);
    const id = created.body.schedule.id as string;
    assert.equal(created.body.schedule.scheduleKind, 'interval');

    const cron = await call(handleBackupScheduleRoutes, 'POST', '/api/backup/schedules', {
      name: 'nightly',
      kind: 'cron',
      cronExpr: '30 2 * * *',
    });
    assert.equal(cron.status, 201);
    const cronId = cron.body.schedule.id as string;

    const list = await call(handleBackupScheduleRoutes, 'GET', '/api/backup/schedules');
    assert.equal(list.status, 200);
    assert.equal(list.body.schedules.length, 2);

    const one = await call(handleBackupScheduleRoutes, 'GET', `/api/backup/schedules/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.schedule.id, id);

    const missing = await call(handleBackupScheduleRoutes, 'GET', '/api/backup/schedules/nope');
    assert.equal(missing.status, 404);

    const patched = await call(handleBackupScheduleRoutes, 'PATCH', `/api/backup/schedules/${id}`, {
      enabled: false,
      name: 'renamed',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.schedule.enabled, false);
    assert.equal(patched.body.schedule.name, 'renamed');

    const badPatch = await call(handleBackupScheduleRoutes, 'PATCH', `/api/backup/schedules/${cronId}`, {
      intervalMs: 60000,
    });
    assert.equal(badPatch.status, 400, 'intervalMs on a cron schedule is rejected');

    const run = await call(handleBackupScheduleRoutes, 'POST', `/api/backup/schedules/${cronId}/run`);
    assert.equal(run.status, 200);
    assert.equal(run.body.manual, true);
    assert.ok(run.body.backupId.startsWith('scheduled-'));
    const ran = listBackupManifests().find((m) => m.backupId === run.body.backupId);
    assert.ok(ran && ran.kind === 'scheduled');

    const del = await call(handleBackupScheduleRoutes, 'DELETE', `/api/backup/schedules/${id}`);
    assert.equal(del.status, 200);
    const gone = await call(handleBackupScheduleRoutes, 'GET', `/api/backup/schedules/${id}`);
    assert.equal(gone.status, 404);
  });

  it('a failing scheduled run is recorded failed and its slot still advances', () => {
    const { world } = tmpWorld();
    const boom = new BackupScheduler({
      schedules: world.fdb.backupSchedules,
      audit: {
        record: (actor: string, event: string, entityType: string, entityId: string, details?: Record<string, unknown>) =>
          world.audit.record(actor, event, entityType, entityId, details),
      },
      runBackup: () => {
        throw new Error('disk is on fire');
      },
      now: () => new Date('2026-10-13T08:00:00.000Z'),
    });
    const s = world.fdb.backupSchedules.create(
      { name: 'flaky', scheduleKind: 'interval', intervalMs: 60000 },
      '2026-10-13T07:59:00.000Z',
      'human',
      '2026-10-13T07:00:00.000Z',
    );
    const { ran, failed } = boom.tick();
    assert.deepEqual(ran, []);
    assert.deepEqual(failed, [s.id]);
    const row = world.fdb.backupSchedules.get(s.id)!;
    assert.equal(row.lastStatus, 'failed');
    assert.equal(row.nextRunAt, '2026-10-13T08:01:00.000Z');
    // Second tick at the new slot does not immediately retry.
    const again = boom.tick();
    assert.deepEqual(again.failed, []);
  });
});
