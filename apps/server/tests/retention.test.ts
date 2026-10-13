/**
 * Retention + legal hold — SPEC v2 §47 (Batch 14).
 *
 * What this pins:
 *  1. Default is KEEP FOREVER: with no policy, evaluate reports zero
 *     candidates for every category and enforce deletes zero — even
 *     for ancient rows. Enforce without the exact confirm text is a
 *     400 and deletes nothing.
 *  2. Policies are validated (excluded/unknown categories and bad day
 *     values are 400s), persisted in SQLite, and audited.
 *  3. Expiry semantics per category: terminal runs by finished_at,
 *     terminal intents by persisted_at, checkpoints by captured_at.
 *     RUNNING runs and PENDING intents are never candidates; records
 *     whose project cannot be resolved are unknown-ref-exempt (§47:
 *     unknown references block cleanup), never deleted.
 *  4. evaluate is a pure dry run — rows are still there afterwards;
 *     enforce deletes exactly the evaluated set, and the
 *     RETENTION_ENFORCED audit record reconciles the counts.
 *  5. Legal hold beats retention: a PROJECT hold exempts that
 *     project's records while others are swept; releasing the hold
 *     makes them eligible again. Hold set/release are audited. A
 *     GLOBAL hold exempts everything, including backups (whole-DB
 *     snapshots); aged backups are swept once no hold is active.
 *
 * Imports the routes from src (like runtime-runs-persistence.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
} from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';
import { handleRetentionRoutes } from '../src/routes/retention.ts';
import {
  backupDirPath,
  createBackup,
  handleBackupRoutes,
  initBackupService,
  listBackupManifests,
  stagedRestoreBackupId,
} from '../src/routes/backup.ts';
import type { RouteContext } from '../src/routes/context.ts';

const OLD_ISO = '2020-01-01T00:00:00.000Z';
const OLD_MS = Date.parse(OLD_ISO);
const CONFIRM = { confirm: 'DELETE_EXPIRED' };

function makeWorld(dir: string) {
  const file = join(dir, 'factory.db');
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
  fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
  fdb.createProject({ id: 'p2', name: 'P2', description: '', path: '' });
  const mkTask = (projectId: string, title: string) =>
    tasks.create({
      projectId,
      title,
      goal: 'g',
      description: '',
      priority: 'P2',
      acceptanceCriteria: [],
      constraints: [],
      creator: 'human',
    });
  return { file, fdb, tasks, evidence, audit, agents, mkTask };
}

function makeCall(world: ReturnType<typeof makeWorld>) {
  return async (
    handler: typeof handleRetentionRoutes,
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
      // Exactly the accessors apps/server/src/index.ts injects.
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
    const handled = await handler(
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

function seedRun(
  world: ReturnType<typeof makeWorld>,
  r: { id: string; taskId: string; status: string; finishedAt: string | null },
): void {
  world.fdb.db
    .prepare(
      `INSERT INTO runtime_runs
         (id, agent_id, task_id, status, outcome, steps, evidence, handoffs, trace, created_at, finished_at, error)
       VALUES (?, 'a1', ?, ?, NULL, 1, '[]', '[]', '[]', ?, ?, NULL)`,
    )
    .run(r.id, r.taskId, r.status, OLD_ISO, r.finishedAt);
}

function seedIntent(
  world: ReturnType<typeof makeWorld>,
  r: { id: string; runId: string; status: string; persistedAt: number },
): void {
  world.fdb.db
    .prepare(
      `INSERT INTO step_intents
         (id, run_id, tool, args_hash, capability_ref, persisted_at, status, result_hash)
       VALUES (?, ?, 'echo', 'h', NULL, ?, ?, 'rh')`,
    )
    .run(r.id, r.runId, r.persistedAt, r.status);
}

function seedCheckpoint(
  world: ReturnType<typeof makeWorld>,
  r: { runId: string; pos: number; capturedAt: number },
): void {
  world.fdb.db
    .prepare(
      `INSERT INTO checkpoints
         (run_id, step_position, schema_version, workflow_version, task_version,
          context_manifest_hash, active_tools, active_processes, lease_generation,
          fencing_token, pending_approvals, budget_usage, pending_side_effects,
          resume_preconditions, captured_at)
       VALUES (?, ?, 'v1', 'wf', 'tv', 'cmh', '[]', '[]', 1, 1, '[]', '{}', '[]', '[]', ?)`,
    )
    .run(r.runId, r.pos, r.capturedAt);
}

function count(world: ReturnType<typeof makeWorld>, table: string): number {
  const row = world.fdb.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return Number(row.n);
}

function category(report: any, name: string): any {
  const c = report.categories.find((x: any) => x.category === name);
  assert.ok(c, `category ${name} in report`);
  return c;
}

function tmpWorld(): { dir: string; world: ReturnType<typeof makeWorld> } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-retention-'));
  return { dir, world: makeWorld(dir) };
}

describe('retention + legal hold (§47)', () => {
  it('no policy: evaluate is all keep-forever, enforce deletes nothing, confirm is mandatory', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const task = world.mkTask('p1', 'T1');
      seedRun(world, { id: 'run-old', taskId: task.id, status: 'COMPLETED', finishedAt: OLD_ISO });
      seedIntent(world, { id: 'int-old', runId: 'run-old', status: 'EXECUTED', persistedAt: OLD_MS });
      seedCheckpoint(world, { runId: 'run-old', pos: 1, capturedAt: OLD_MS });

      const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      assert.equal(ev.status, 200);
      for (const c of ev.body.categories) assert.equal(c.candidates, 0, c.category);
      assert.ok(
        ev.body.excluded.some((e: any) => e.category === 'audit_logs'),
        'audit_logs reported as excluded',
      );

      const noConfirm = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', {});
      assert.equal(noConfirm.status, 400);
      const wrongConfirm = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', {
        confirm: 'yes',
      });
      assert.equal(wrongConfirm.status, 400);

      const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.status, 200);
      assert.deepEqual(en.body.deleted, {
        checkpoints: 0,
        step_intents: 0,
        runtime_runs: 0,
        backups: 0,
        sboms: 0, // Batch 26: new retention category, still keep-forever here
      });
      assert.equal(count(world, 'runtime_runs'), 1);
      assert.equal(count(world, 'step_intents'), 1);
      assert.equal(count(world, 'checkpoints'), 1);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('policies: validation, persistence across reopen, audit', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const bad1 = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { audit_logs: 30 },
      });
      assert.equal(bad1.status, 400);
      const bad2 = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { nope: 30 },
      });
      assert.equal(bad2.status, 400);
      const bad3 = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { runtime_runs: -5 },
      });
      assert.equal(bad3.status, 400);

      const ok = await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30, step_intents: 30, checkpoints: 30, backups: 30 },
      });
      assert.equal(ok.status, 200);
      const got = await call(handleRetentionRoutes, 'GET', '/api/retention/policies');
      assert.equal(
        got.body.policies.find((p: any) => p.category === 'runtime_runs').retentionDays,
        30,
      );
      assert.ok(
        world.audit.list().some((r) => r.action === 'RETENTION_POLICY_UPDATED'),
        'policy update audited',
      );

      world.fdb.close();
      const fdb2 = new FactoryDatabase(world.file);
      try {
        assert.equal(fdb2.retention.getPolicy('runtime_runs').retentionDays, 30);
        assert.equal(fdb2.retention.getPolicy('backups').retentionDays, 30);
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expiry: only terminal+expired+resolvable rows are candidates; dry run deletes nothing; enforce reconciles', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const task = world.mkTask('p1', 'T1');
      const nowIso = new Date().toISOString();
      seedRun(world, { id: 'run-old', taskId: task.id, status: 'COMPLETED', finishedAt: OLD_ISO });
      seedRun(world, { id: 'run-fresh', taskId: task.id, status: 'COMPLETED', finishedAt: nowIso });
      seedRun(world, { id: 'run-running', taskId: task.id, status: 'RUNNING', finishedAt: null });
      seedIntent(world, { id: 'int-old', runId: 'run-old', status: 'EXECUTED', persistedAt: OLD_MS });
      seedIntent(world, { id: 'int-fresh', runId: 'run-fresh', status: 'EXECUTED', persistedAt: Date.now() });
      seedIntent(world, { id: 'int-pending', runId: 'run-old', status: 'PENDING', persistedAt: OLD_MS });
      seedIntent(world, { id: 'int-orphan', runId: 'ghost-run', status: 'EXECUTED', persistedAt: OLD_MS });
      seedCheckpoint(world, { runId: 'run-old', pos: 1, capturedAt: OLD_MS });
      seedCheckpoint(world, { runId: 'run-fresh', pos: 1, capturedAt: Date.now() });

      await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30, step_intents: 30, checkpoints: 30 },
      });

      const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      assert.equal(ev.status, 200);
      assert.deepEqual(category(ev.body, 'runtime_runs').sampleIds, ['run-old']);
      assert.equal(category(ev.body, 'runtime_runs').candidates, 1);
      const intents = category(ev.body, 'step_intents');
      assert.equal(intents.candidates, 1);
      assert.deepEqual(intents.sampleIds, ['int-old']);
      assert.equal(intents.unknownRefExempt, 1, 'orphan intent is unknown-ref-exempt');
      assert.equal(category(ev.body, 'checkpoints').candidates, 1);

      // Dry run deleted nothing.
      assert.equal(count(world, 'runtime_runs'), 3);
      assert.equal(count(world, 'step_intents'), 4);
      assert.equal(count(world, 'checkpoints'), 2);

      const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.status, 200);
      assert.equal(en.body.deleted.runtime_runs, 1);
      assert.equal(en.body.deleted.step_intents, 1);
      assert.equal(en.body.deleted.checkpoints, 1);
      assert.equal(count(world, 'runtime_runs'), 2, 'fresh + RUNNING survive');
      assert.equal(count(world, 'step_intents'), 3, 'fresh + PENDING + orphan survive');
      assert.equal(count(world, 'checkpoints'), 1);

      const rec = world.audit
        .list()
        .find((r) => r.action === 'RETENTION_ENFORCED');
      assert.ok(rec, 'enforcement audited');
      assert.equal((rec.details['deleted'] as any)['runtime_runs'], 1);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legal hold: PROJECT hold exempts its project only; release re-enables; set/release audited', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const t1 = world.mkTask('p1', 'T1');
      const t2 = world.mkTask('p2', 'T2');
      seedRun(world, { id: 'run-p1', taskId: t1.id, status: 'COMPLETED', finishedAt: OLD_ISO });
      seedRun(world, { id: 'run-p2', taskId: t2.id, status: 'COMPLETED', finishedAt: OLD_ISO });
      await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30 },
      });

      const unknownProject = await call(handleRetentionRoutes, 'POST', '/api/retention/holds', {
        scope: 'PROJECT',
        projectId: 'nope',
      });
      assert.equal(unknownProject.status, 404);

      const set = await call(handleRetentionRoutes, 'POST', '/api/retention/holds', {
        scope: 'PROJECT',
        projectId: 'p1',
        reason: 'litigation',
      });
      assert.equal(set.status, 201);
      const holdId = set.body.hold.id as string;
      const dup = await call(handleRetentionRoutes, 'POST', '/api/retention/holds', {
        scope: 'PROJECT',
        projectId: 'p1',
      });
      assert.equal(dup.status, 409);
      assert.ok(world.audit.list().some((r) => r.action === 'LEGAL_HOLD_SET'));

      const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      const runs = category(ev.body, 'runtime_runs');
      assert.equal(runs.candidates, 1);
      assert.deepEqual(runs.sampleIds, ['run-p2']);
      assert.equal(runs.heldExempt, 1);

      const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.body.deleted.runtime_runs, 1);
      assert.equal(count(world, 'runtime_runs'), 1, 'held project run survives');

      const rel = await call(
        handleRetentionRoutes,
        'POST',
        `/api/retention/holds/${holdId}/release`,
        {},
      );
      assert.equal(rel.status, 200);
      assert.ok(world.audit.list().some((r) => r.action === 'LEGAL_HOLD_RELEASED'));
      const relAgain = await call(
        handleRetentionRoutes,
        'POST',
        `/api/retention/holds/${holdId}/release`,
        {},
      );
      assert.equal(relAgain.status, 409);

      const en2 = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en2.body.deleted.runtime_runs, 1, 'released hold: record now swept');
      assert.equal(count(world, 'runtime_runs'), 0);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GLOBAL hold exempts everything incl. backups; aged backups sweep once released', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const backupDir = join(dir, 'backups');
      initBackupService({ dbPath: world.file, backupDir, appVersion: 'test' });
      const task = world.mkTask('p1', 'T1');
      seedRun(world, { id: 'run-old', taskId: task.id, status: 'COMPLETED', finishedAt: OLD_ISO });
      const { backupId, dir: bdir } = createBackup(world.fdb, 'manual');
      // Age the backup past the policy by rewriting its manifest.
      const manifestPath = join(bdir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.createdAt = OLD_ISO;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30, backups: 30 },
      });
      const hold = await call(handleRetentionRoutes, 'POST', '/api/retention/holds', {
        scope: 'GLOBAL',
        reason: 'regulator request',
      });
      assert.equal(hold.status, 201);

      const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      assert.equal(category(ev.body, 'runtime_runs').heldExempt, 1);
      assert.equal(category(ev.body, 'runtime_runs').candidates, 0);
      assert.equal(category(ev.body, 'backups').heldExempt, 1);
      assert.equal(category(ev.body, 'backups').candidates, 0);

      const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.body.deleted.runtime_runs, 0);
      assert.equal(en.body.deleted.backups, 0);
      assert.ok(existsSync(bdir), 'held backup directory untouched');

      await call(
        handleRetentionRoutes,
        'POST',
        `/api/retention/holds/${hold.body.hold.id}/release`,
        {},
      );
      const ev2 = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      assert.equal(category(ev2.body, 'backups').candidates, 1);
      assert.deepEqual(category(ev2.body, 'backups').sampleIds, [backupId]);
      const en2 = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en2.body.deleted.backups, 1);
      assert.equal(en2.body.deleted.runtime_runs, 1);
      assert.ok(!existsSync(bdir), 'aged backup directory removed after release');
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a backup staged for restore is exempt even with no hold', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      const backupDir = join(dir, 'backups');
      initBackupService({ dbPath: world.file, backupDir, appVersion: 'test' });
      const { backupId, dir: bdir } = createBackup(world.fdb, 'manual');
      const manifestPath = join(bdir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.createdAt = OLD_ISO;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Stage a restore of the aged backup through the real route.
      const staged = await call(handleBackupRoutes, 'POST', '/api/restore', { backupId });
      assert.equal(staged.status, 200);
      assert.equal(staged.body.restartRequired, true);

      await call(handleRetentionRoutes, 'PUT', '/api/retention/policies', {
        policies: { backups: 30 },
      });
      const ev = await call(handleRetentionRoutes, 'POST', '/api/retention/evaluate');
      const backups = category(ev.body, 'backups');
      // The aged original is exempt (staged); the fresh pre-restore
      // backup is not expired. Nothing is a candidate.
      assert.equal(backups.candidates, 0);
      assert.equal(backups.heldExempt, 1);
      const en = await call(handleRetentionRoutes, 'POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.body.deleted.backups, 0);
      assert.ok(existsSync(bdir), 'staged backup survives enforcement');
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
