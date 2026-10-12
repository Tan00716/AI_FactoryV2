/**
 * Retention tombstones, end to end — Batch 15 (§47 follow-up).
 *
 * The Batch 14 residue, reproduced at the HTTP surface: enforce
 * deletes an expired run; the run's leftover step intents and
 * checkpoints used to become permanent unknown-ref orphans. Now the
 * deletion leaves a run → project tombstone in the db, and the NEXT
 * evaluation resolves the leftovers through it:
 *
 *   - with no hold, they are deletion candidates under their (still
 *     existing) project's policies — and enforce really sweeps them;
 *   - with an active PROJECT hold on that project, they stay exempt
 *     as held (not as unknown), and releasing the hold frees them;
 *   - a true orphan (no run row, never had a tombstone) remains
 *     unknown-ref-exempt and is never deleted.
 *
 * Harness mirrors retention.test.ts (routes imported from src).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const task = tasks.create({
    projectId: 'p1',
    title: 'T1',
    goal: 'g',
    description: '',
    priority: 'P2',
    acceptanceCriteria: [],
    constraints: [],
    creator: 'human',
  });
  return { file, fdb, tasks, evidence, audit, agents, task };
}

type World = ReturnType<typeof makeWorld>;

function makeCall(world: World) {
  return async (
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
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
      readBody: async () => body,
    } as unknown as RouteContext;
    const handled = await handleRetentionRoutes(
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

function seedRun(world: World, id: string, taskId: string): void {
  world.fdb.db
    .prepare(
      `INSERT INTO runtime_runs
         (id, agent_id, task_id, status, outcome, steps, evidence, handoffs, trace, created_at, finished_at, error)
       VALUES (?, 'a1', ?, 'COMPLETED', NULL, 1, '[]', '[]', '[]', ?, ?, NULL)`,
    )
    .run(id, taskId, OLD_ISO, OLD_ISO);
}

function seedIntent(world: World, id: string, runId: string): void {
  world.fdb.db
    .prepare(
      `INSERT INTO step_intents
         (id, run_id, tool, args_hash, capability_ref, persisted_at, status, result_hash)
       VALUES (?, ?, 'echo', 'h', NULL, ?, 'EXECUTED', 'rh')`,
    )
    .run(id, runId, OLD_MS);
}

function seedCheckpoint(world: World, runId: string, pos: number): void {
  world.fdb.db
    .prepare(
      `INSERT INTO checkpoints
         (run_id, step_position, schema_version, workflow_version, task_version,
          context_manifest_hash, active_tools, active_processes, lease_generation,
          fencing_token, pending_approvals, budget_usage, pending_side_effects,
          resume_preconditions, captured_at)
       VALUES (?, ?, 'v1', 'wf', 'tv', 'cmh', '[]', '[]', 1, 1, '[]', '{}', '[]', '[]', ?)`,
    )
    .run(runId, pos, OLD_MS);
}

function count(world: World, table: string): number {
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

function tmpWorld(): { dir: string; world: World } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-retention-tomb-'));
  return { dir, world: makeWorld(dir) };
}

describe('retention tombstones — enforce leaves a resolvable mapping (§47, Batch 15)', () => {
  it('after the run is enforced away, its intents/checkpoints are candidates next round — and get swept', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      seedRun(world, 'run-old', world.task.id);
      seedIntent(world, 'int-old', 'run-old');
      seedCheckpoint(world, 'run-old', 1);

      // Round 1: only runs have a policy — enforce deletes the run,
      // and (children-first order aside) the intents/checkpoints stay
      // because their own categories are keep-forever this round.
      const pol = await call('PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30 },
      });
      assert.equal(pol.status, 200);
      const en1 = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en1.status, 200);
      assert.equal(en1.body.deleted.runtime_runs, 1);
      assert.equal(count(world, 'runtime_runs'), 0);
      assert.equal(count(world, 'step_intents'), 1);
      assert.equal(count(world, 'checkpoints'), 1);

      // The tombstone is the only trace of the run's project now.
      assert.equal(world.fdb.retention.getRunTombstone('run-old')?.projectId, 'p1');

      // Round 2: policies for the leftovers. Pre-Batch-15 these were
      // unknownRefExempt forever; now they resolve via tombstone.
      const pol2 = await call('PUT', '/api/retention/policies', {
        policies: { step_intents: 30, checkpoints: 30 },
      });
      assert.equal(pol2.status, 200);
      const ev = await call('POST', '/api/retention/evaluate');
      assert.equal(ev.status, 200);
      assert.equal(category(ev.body, 'step_intents').candidates, 1);
      assert.equal(category(ev.body, 'step_intents').unknownRefExempt, 0);
      assert.equal(category(ev.body, 'checkpoints').candidates, 1);
      assert.equal(category(ev.body, 'checkpoints').unknownRefExempt, 0);

      const en2 = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en2.status, 200);
      assert.equal(en2.body.deleted.step_intents, 1);
      assert.equal(en2.body.deleted.checkpoints, 1);
      assert.equal(count(world, 'step_intents'), 0);
      assert.equal(count(world, 'checkpoints'), 0);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a PROJECT hold on the tombstoned run’s project keeps the leftovers held-exempt until released', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      seedRun(world, 'run-held', world.task.id);
      seedIntent(world, 'int-held', 'run-held');
      seedCheckpoint(world, 'run-held', 1);

      await call('PUT', '/api/retention/policies', {
        policies: { runtime_runs: 30, step_intents: 30, checkpoints: 30 },
      });
      // Policies for intents/checkpoints exist too, but the run goes
      // first across two rounds so the leftovers outlive it: round 1
      // uses a runs-only enforcement by clearing the other policies.
      await call('PUT', '/api/retention/policies', {
        policies: { step_intents: null, checkpoints: null },
      });
      const en1 = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en1.body.deleted.runtime_runs, 1);
      assert.equal(count(world, 'step_intents'), 1);

      const hold = await call('POST', '/api/retention/holds', {
        scope: 'PROJECT',
        projectId: 'p1',
        reason: 'investigation',
      });
      assert.equal(hold.status, 201);
      const holdId = hold.body.hold.id as string;

      await call('PUT', '/api/retention/policies', {
        policies: { step_intents: 30, checkpoints: 30 },
      });
      const ev = await call('POST', '/api/retention/evaluate');
      // Exempt as HELD (their project is known via the tombstone),
      // not as unknown-ref.
      assert.equal(category(ev.body, 'step_intents').candidates, 0);
      assert.equal(category(ev.body, 'step_intents').heldExempt, 1);
      assert.equal(category(ev.body, 'step_intents').unknownRefExempt, 0);
      assert.equal(category(ev.body, 'checkpoints').heldExempt, 1);

      const en2 = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en2.body.deleted.step_intents, 0);
      assert.equal(en2.body.deleted.checkpoints, 0);
      assert.equal(count(world, 'step_intents'), 1);
      assert.equal(count(world, 'checkpoints'), 1);

      const rel = await call('POST', `/api/retention/holds/${holdId}/release`, {});
      assert.equal(rel.status, 200);
      const en3 = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en3.body.deleted.step_intents, 1);
      assert.equal(en3.body.deleted.checkpoints, 1);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a true orphan (run never existed, no tombstone) remains unknown-ref-exempt and undeleted', async () => {
    const { dir, world } = tmpWorld();
    try {
      const call = makeCall(world);
      seedIntent(world, 'int-orphan', 'ghost-run');
      seedCheckpoint(world, 'ghost-run', 2);
      assert.equal(world.fdb.retention.getRunTombstone('ghost-run'), undefined);

      await call('PUT', '/api/retention/policies', {
        policies: { step_intents: 30, checkpoints: 30 },
      });
      const ev = await call('POST', '/api/retention/evaluate');
      assert.equal(category(ev.body, 'step_intents').candidates, 0);
      assert.equal(category(ev.body, 'step_intents').unknownRefExempt, 1);
      assert.equal(category(ev.body, 'checkpoints').candidates, 0);
      assert.equal(category(ev.body, 'checkpoints').unknownRefExempt, 1);

      const en = await call('POST', '/api/retention/enforce', CONFIRM);
      assert.equal(en.body.deleted.step_intents, 0);
      assert.equal(en.body.deleted.checkpoints, 0);
      assert.equal(count(world, 'step_intents'), 1);
      assert.equal(count(world, 'checkpoints'), 1);
    } finally {
      world.fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
