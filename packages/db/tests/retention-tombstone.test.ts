/**
 * Retention tombstones — Batch 15 (§47 follow-up to Batch 14).
 *
 * The Batch 14 residue: when retention enforcement deleted a
 * runtime_runs row, the run's leftover step intents / checkpoints
 * lost their only project resolution path (run → task → project) and
 * became permanent unknown-ref orphans — exempt forever, never
 * sweepable even when their project's policy said otherwise.
 *
 * This file pins the tombstone contract:
 *  - deleteRuntimeRuns resolves each row's project BEFORE deleting
 *    and records run_id → project_id in retention_tombstones (only
 *    for rows that actually disappeared, only when a project was
 *    resolvable);
 *  - later evaluations of step_intents / checkpoints resolve through
 *    the tombstone: the records become candidates under their
 *    project's policy, and a PROJECT hold on that project still
 *    exempts them;
 *  - a true orphan (no run row, no tombstone) stays
 *    unknown-ref-exempt forever — §47 is not weakened;
 *  - the tombstone stores only the id pair + deletion time + reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '../src/index';
import type { LegalHold } from '../src/index';

const OLD_ISO = '2020-01-01T00:00:00.000Z';
const OLD_MS = Date.parse(OLD_ISO);
const DAY_MS = 86_400_000;
// A 30-day cutoff against "now": everything seeded at 2020 is expired.
const CUTOFF_MS = Date.now() - 30 * DAY_MS;
const CUTOFF_ISO = new Date(CUTOFF_MS).toISOString();

function tmpFdb(): { dir: string; fdb: FactoryDatabase } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-tombstone-'));
  return { dir, fdb: new FactoryDatabase(join(dir, 'factory.db')) };
}

function seedTask(fdb: FactoryDatabase, id: string, projectId: string): void {
  fdb.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, 't', ?, ?)`,
    )
    .run(id, projectId, OLD_ISO, OLD_ISO);
}

function seedRun(fdb: FactoryDatabase, id: string, taskId: string): void {
  fdb.db
    .prepare(
      `INSERT INTO runtime_runs
         (id, agent_id, task_id, status, outcome, steps, evidence, handoffs, trace, created_at, finished_at, error)
       VALUES (?, 'a1', ?, 'COMPLETED', NULL, 1, '[]', '[]', '[]', ?, ?, NULL)`,
    )
    .run(id, taskId, OLD_ISO, OLD_ISO);
}

function seedIntent(fdb: FactoryDatabase, id: string, runId: string): void {
  fdb.db
    .prepare(
      `INSERT INTO step_intents
         (id, run_id, tool, args_hash, capability_ref, persisted_at, status, result_hash)
       VALUES (?, ?, 'echo', 'h', NULL, ?, 'EXECUTED', 'rh')`,
    )
    .run(id, runId, OLD_MS);
}

function seedCheckpoint(fdb: FactoryDatabase, runId: string, pos: number): void {
  fdb.db
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

function projectHold(projectId: string): LegalHold {
  return {
    id: `hold-${projectId}`,
    scope: 'PROJECT',
    projectId,
    reason: 'litigation',
    setBy: 'human',
    setAt: OLD_ISO,
    releasedAt: null,
    releasedBy: null,
  };
}

describe('retention tombstones (Batch 15)', () => {
  it('deleting a run tombstones its project; leftover intents/checkpoints become sweepable candidates', () => {
    const { dir, fdb } = tmpFdb();
    try {
      const store = fdb.retention;
      fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
      seedTask(fdb, 't1', 'p1');
      seedRun(fdb, 'r1', 't1');
      seedIntent(fdb, 'i1', 'r1');
      seedCheckpoint(fdb, 'r1', 1);

      // Sanity: while the run row lives, the chain resolves directly.
      const before = store.evaluateCategory('step_intents', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(before.candidates, ['i1']);

      assert.equal(store.deleteRuntimeRuns(['r1']), 1);

      const tomb = store.getRunTombstone('r1');
      assert.ok(tomb, 'tombstone recorded for the deleted run');
      assert.equal(tomb.projectId, 'p1');
      assert.equal(tomb.reason, 'retention');
      assert.ok(!Number.isNaN(Date.parse(tomb.deletedAt)), 'deletedAt is an ISO time');
      // The tombstone is only a mapping — no other fields exist on it.
      assert.deepEqual(Object.keys(tomb).sort(), [
        'deletedAt',
        'projectId',
        'reason',
        'runId',
      ]);

      // The leftovers now resolve through the tombstone: candidates,
      // not unknown-ref orphans.
      const intents = store.evaluateCategory('step_intents', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(intents.candidates, ['i1']);
      assert.equal(intents.unknownRefExempt, 0);
      const ckpts = store.evaluateCategory('checkpoints', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(ckpts.candidates, ['r1#1']);
      assert.equal(ckpts.unknownRefExempt, 0);

      // And the sweep can actually take them now.
      assert.equal(store.deleteStepIntents(intents.candidates), 1);
      assert.equal(store.deleteCheckpoints(ckpts.candidates), 1);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tombstone-resolved records still honor a PROJECT hold on their project', () => {
    const { dir, fdb } = tmpFdb();
    try {
      const store = fdb.retention;
      fdb.createProject({ id: 'p2', name: 'P2', description: '', path: '' });
      seedTask(fdb, 't2', 'p2');
      seedRun(fdb, 'r2', 't2');
      seedIntent(fdb, 'i2', 'r2');
      seedCheckpoint(fdb, 'r2', 1);

      assert.equal(store.deleteRuntimeRuns(['r2']), 1);
      assert.equal(store.getRunTombstone('r2')?.projectId, 'p2');

      store.addHold(projectHold('p2'));
      const held = store.activeHolds();
      const intentsHeld = store.evaluateCategory('step_intents', CUTOFF_ISO, CUTOFF_MS, held);
      assert.deepEqual(intentsHeld.candidates, []);
      assert.equal(intentsHeld.heldExempt, 1);
      assert.equal(intentsHeld.unknownRefExempt, 0);
      const ckptsHeld = store.evaluateCategory('checkpoints', CUTOFF_ISO, CUTOFF_MS, held);
      assert.deepEqual(ckptsHeld.candidates, []);
      assert.equal(ckptsHeld.heldExempt, 1);

      // Releasing the hold makes them eligible again — via tombstone.
      store.releaseHold('hold-p2', 'human', new Date().toISOString());
      const after = store.evaluateCategory(
        'step_intents',
        CUTOFF_ISO,
        CUTOFF_MS,
        store.activeHolds(),
      );
      assert.deepEqual(after.candidates, ['i2']);
      assert.equal(after.heldExempt, 0);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('true orphans (no run row, no tombstone) stay unknown-ref-exempt forever', () => {
    const { dir, fdb } = tmpFdb();
    try {
      const store = fdb.retention;
      seedIntent(fdb, 'i9', 'ghost-run');
      seedCheckpoint(fdb, 'ghost-run', 3);

      assert.equal(store.getRunTombstone('ghost-run'), undefined);
      const intents = store.evaluateCategory('step_intents', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(intents.candidates, []);
      assert.equal(intents.unknownRefExempt, 1);
      const ckpts = store.evaluateCategory('checkpoints', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(ckpts.candidates, []);
      assert.equal(ckpts.unknownRefExempt, 1);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no tombstone when nothing was deleted, and none for a run whose project never resolved', () => {
    const { dir, fdb } = tmpFdb();
    try {
      const store = fdb.retention;
      // Unknown id: deletes nothing, remembers nothing.
      assert.equal(store.deleteRuntimeRuns(['nope']), 0);
      assert.deepEqual(store.listRunTombstones(), []);

      // A run whose task row is gone: its project cannot be resolved
      // even at deletion time, so there is no mapping to remember —
      // and its leftovers remain unknown-ref-exempt afterwards.
      seedRun(fdb, 'rX', 'missing-task');
      seedIntent(fdb, 'iX', 'rX');
      assert.equal(store.deleteRuntimeRuns(['rX']), 1);
      assert.equal(store.getRunTombstone('rX'), undefined);
      const intents = store.evaluateCategory('step_intents', CUTOFF_ISO, CUTOFF_MS, []);
      assert.deepEqual(intents.candidates, []);
      assert.equal(intents.unknownRefExempt, 1);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tombstones survive reopening the database', () => {
    const { dir, fdb } = tmpFdb();
    const file = join(dir, 'factory.db');
    try {
      fdb.createProject({ id: 'p3', name: 'P3', description: '', path: '' });
      seedTask(fdb, 't3', 'p3');
      seedRun(fdb, 'r3', 't3');
      seedIntent(fdb, 'i3', 'r3');
      assert.equal(fdb.retention.deleteRuntimeRuns(['r3']), 1);
    } finally {
      fdb.close();
    }
    const fdb2 = new FactoryDatabase(file);
    try {
      assert.equal(fdb2.retention.getRunTombstone('r3')?.projectId, 'p3');
      const intents = fdb2.retention.evaluateCategory(
        'step_intents',
        CUTOFF_ISO,
        CUTOFF_MS,
        [],
      );
      assert.deepEqual(intents.candidates, ['i3']);
    } finally {
      fdb2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
