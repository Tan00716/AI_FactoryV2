/**
 * Durable v2 engine state — SPEC v2 §18/§19/§20.1 (Batch 13).
 *
 * The WorkflowEngineV2 mirror (core's TaskV2State) used to live only
 * in the server process: a restart re-seeded it approximately from
 * the v1 task row and lost everything the row cannot express —
 * recorded milestones, the history arrays, the outcome-gate validity
 * flag, the taskVersion, and the §20.1 final seal (F1 residual). It
 * now sits behind the TaskV2StateStore seam
 * (packages/db/src/task-v2-state.ts), and this file pins the SQLite
 * implementation (task_v2_state table):
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results at
 *    every step — upsert identity (the task id),
 *    replace-keeps-position, first-put order, unknown id → undefined;
 *  - fidelity across instances: a new FactoryDatabase over the same
 *    file reads back every field exactly — nested condition record,
 *    milestone map, all three history arrays, both flags, the
 *    taskVersion, and the nullable requirement pin (NULL ↔ null);
 *  - copy contract: mutating a fetched state, or the input after
 *    put(), cannot corrupt stored state, in either implementation;
 *  - old databases: a file that predates the task_v2_state table
 *    gains it on open (CREATE TABLE IF NOT EXISTS in SCHEMA).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskV2State } from '@ai-factory/core';
import {
  FactoryDatabase,
  InMemoryTaskV2StateStore,
  SqliteTaskV2StateStore,
  type TaskV2StateStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-v2state-'));
  return { dir, file: join(dir, 'factory.db') };
}

const NOT_ACHIEVED = { achieved: false, at: null, evidenceRef: null };

/** A mid-flight state with every field off its default. */
function midFlight(taskId: string): TaskV2State {
  return {
    taskId,
    stage: 'OUTCOME_VERIFICATION',
    condition: {
      condition: 'BLOCKED',
      reason: 'waiting on vendor sign-off',
      resumeState: 'PROD_VERIFICATION',
      blockedOn: ['dep-1', 'task-9'],
      updatedAt: '2026-10-12T09:30:00.000Z',
      updatedBy: 'agent-1',
    },
    milestones: {
      IMPLEMENTED: { achieved: true, at: '2026-10-12T08:00:00.000Z', evidenceRef: 'ev-code' },
      VERIFIED: { achieved: true, at: '2026-10-12T08:40:00.000Z', evidenceRef: 'ev-qa' },
      RELEASED: { achieved: true, at: '2026-10-12T09:00:00.000Z', evidenceRef: null },
      OUTCOME_VERIFIED: { ...NOT_ACHIEVED },
      DONE: { ...NOT_ACHIEVED },
    },
    milestoneHistory: [
      { milestone: 'IMPLEMENTED', at: '2026-10-12T08:00:00.000Z', by: 'human' },
      { milestone: 'VERIFIED', at: '2026-10-12T08:40:00.000Z', by: 'human' },
      { milestone: 'RELEASED', at: '2026-10-12T09:00:00.000Z', by: 'human' },
    ],
    releaseState: 'RELEASED',
    releaseHistory: [
      { state: 'RELEASED', at: '2026-10-12T09:00:00.000Z', by: 'human', reason: 'go live' },
    ],
    outcomeGateValid: false,
    finalSeal: 0,
    taskVersion: 14,
    requirementRef: 'REQ-001@2',
    completionTarget: 'RELEASED_OUTCOME',
    completionHistory: [],
    updatedAt: '2026-10-12T09:30:00.000Z',
  };
}

/** A finalized state: DONE + finalSeal 1, no requirement pin. */
function finalized(taskId: string): TaskV2State {
  return {
    taskId,
    stage: 'DONE',
    condition: {
      condition: 'ACTIVE',
      reason: 'registered',
      resumeState: null,
      blockedOn: [],
      updatedAt: '2026-10-12T07:00:00.000Z',
      updatedBy: 'system',
    },
    milestones: {
      IMPLEMENTED: { achieved: true, at: '2026-10-12T07:10:00.000Z', evidenceRef: 'ev-1' },
      VERIFIED: { achieved: true, at: '2026-10-12T07:20:00.000Z', evidenceRef: 'ev-2' },
      RELEASED: { achieved: true, at: '2026-10-12T07:30:00.000Z', evidenceRef: null },
      OUTCOME_VERIFIED: { achieved: true, at: '2026-10-12T07:40:00.000Z', evidenceRef: null },
      DONE: { achieved: true, at: '2026-10-12T07:50:00.000Z', evidenceRef: null },
    },
    milestoneHistory: [
      { milestone: 'IMPLEMENTED', at: '2026-10-12T07:10:00.000Z', by: 'human' },
      { milestone: 'VERIFIED', at: '2026-10-12T07:20:00.000Z', by: 'human' },
      { milestone: 'RELEASED', at: '2026-10-12T07:30:00.000Z', by: 'human' },
      { milestone: 'OUTCOME_VERIFIED', at: '2026-10-12T07:40:00.000Z', by: 'human' },
      { milestone: 'DONE', at: '2026-10-12T07:50:00.000Z', by: 'human' },
    ],
    releaseState: 'RELEASED',
    releaseHistory: [
      { state: 'RELEASED', at: '2026-10-12T07:30:00.000Z', by: 'human', reason: 'ship it' },
    ],
    outcomeGateValid: true,
    finalSeal: 1,
    taskVersion: 16,
    requirementRef: null,
    completionTarget: 'VERIFIED_DELIVERY',
    completionHistory: [
      {
        kind: 'COMPLETED',
        at: '2026-10-12T07:50:00.000Z',
        by: 'human',
        reason: 'all completion predicates hold',
      },
    ],
    updatedAt: '2026-10-12T07:50:00.000Z',
  };
}

describe('TaskV2StateStore parity (in-memory vs SQLite)', () => {
  it('identical results at every step of a scripted sequence', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const stores: Array<[string, TaskV2StateStore]> = [
          ['memory', new InMemoryTaskV2StateStore()],
          ['sqlite', fdb.taskV2States],
        ];
        const script = (store: TaskV2StateStore): unknown[] => {
          const snaps: unknown[] = [];
          snaps.push(store.get('nope'));
          snaps.push(store.list());
          snaps.push(store.count());
          store.put(midFlight('task-a'));
          store.put(finalized('task-b'));
          snaps.push(store.get('task-a'));
          snaps.push(store.list().map((s) => s.taskId));
          // Replace task-a with its finalized form: position kept.
          const aDone: TaskV2State = {
            ...midFlight('task-a'),
            stage: 'DONE',
            finalSeal: 1,
            taskVersion: 17,
            updatedAt: '2026-10-12T10:00:00.000Z',
          };
          store.put(aDone);
          snaps.push(store.get('task-a'));
          snaps.push(store.list().map((s) => s.taskId));
          snaps.push(store.list());
          snaps.push(store.count());
          return snaps;
        };
        const [memSnaps, sqlSnaps] = stores.map(([, s]) => script(s));
        assert.deepEqual(sqlSnaps, memSnaps);
        assert.equal(sqlSnaps[0], undefined);
        assert.deepEqual(sqlSnaps[4], ['task-a', 'task-b']);
        assert.deepEqual(sqlSnaps[6], ['task-a', 'task-b']);
        assert.equal((sqlSnaps[5] as TaskV2State).finalSeal, 1);
        assert.equal((sqlSnaps[5] as TaskV2State).taskVersion, 17);
        assert.equal(sqlSnaps[8], 2);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copy contract holds in both implementations', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const stores: TaskV2StateStore[] = [
          new InMemoryTaskV2StateStore(),
          fdb.taskV2States,
        ];
        for (const store of stores) {
          const input = midFlight('task-x');
          store.put(input);
          // Mutating the caller's object after put must not leak in.
          input.stage = 'DONE';
          input.finalSeal = 1;
          input.condition.blockedOn.push('forged');
          input.milestones.DONE.achieved = true;
          const read1 = store.get('task-x');
          assert.equal(read1?.stage, 'OUTCOME_VERIFICATION');
          assert.equal(read1?.finalSeal, 0);
          assert.deepEqual(read1?.condition.blockedOn, ['dep-1', 'task-9']);
          assert.equal(read1?.milestones.DONE.achieved, false);
          // Mutating a fetched state must not corrupt stored state.
          read1!.stage = 'TODO';
          read1!.milestoneHistory.length = 0;
          const read2 = store.get('task-x');
          assert.deepEqual(read2, midFlight('task-x'));
        }
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteTaskV2StateStore across restarts', () => {
  it('round-trips every field across FactoryDatabase instances', () => {
    const { dir, file } = tmpDbFile();
    try {
      let fdb = new FactoryDatabase(file);
      fdb.taskV2States.put(midFlight('task-a'));
      fdb.taskV2States.put(finalized('task-b'));
      fdb.close();

      fdb = new FactoryDatabase(file);
      try {
        // Field-for-field: nested condition, milestone map, all three
        // history arrays, both flags, taskVersion, updatedAt.
        assert.deepEqual(fdb.taskV2States.get('task-a'), midFlight('task-a'));
        assert.deepEqual(fdb.taskV2States.get('task-b'), finalized('task-b'));
        assert.deepEqual(fdb.taskV2States.list(), [
          midFlight('task-a'),
          finalized('task-b'),
        ]);
        assert.equal(fdb.taskV2States.count(), 2);
        // The two flags and the nullable pin survive exactly: 0/false
        // must not come back truthy, null must not come back invented.
        const a = fdb.taskV2States.get('task-a');
        assert.equal(a?.outcomeGateValid, false);
        assert.equal(a?.finalSeal, 0);
        assert.equal(a?.requirementRef, 'REQ-001@2');
        const b = fdb.taskV2States.get('task-b');
        assert.equal(b?.outcomeGateValid, true);
        assert.equal(b?.finalSeal, 1);
        assert.equal(b?.requirementRef, null);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a database predating the task_v2_state table gains it on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE legacy_thing (id TEXT)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = fdb.db
          .prepare('PRAGMA table_info(task_v2_state)')
          .all() as Array<{ name: string }>;
        assert.deepEqual(
          cols.map((c) => c.name),
          ['task_id', 'stage', 'condition', 'milestones', 'milestone_history',
           'release_state', 'release_history', 'outcome_gate_valid',
           'final_seal', 'task_version', 'requirement_ref',
           'completion_target', 'completion_history', 'updated_at'],
        );
        fdb.taskV2States.put(finalized('old-db-task'));
        assert.deepEqual(fdb.taskV2States.get('old-db-task'), finalized('old-db-task'));
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SqliteTaskV2StateStore can be driven directly on a raw connection', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      fdb.close();
      const raw = new DatabaseSync(file);
      try {
        const store = new SqliteTaskV2StateStore(raw);
        store.put(midFlight('direct'));
        assert.deepEqual(store.get('direct'), midFlight('direct'));
        assert.equal(store.count(), 1);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
