/**
 * Durable checkpoints — SPEC v2 §28.3 (G-59, Batch 11).
 *
 * CheckpointV2 used to be a bare in-process value: created, validated,
 * and lost with the process — the last unpersisted piece of §28 state
 * after step intents (Batch 9) and external operations (Batch 10). It
 * now sits behind the runtime CheckpointStore seam, and this file pins
 * the SQLite implementation (checkpoints table):
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results at
 *    every step — identity (runId, stepPosition), replace semantics,
 *    first-capture order, delete;
 *  - fidelity across instances: a new FactoryDatabase over the same
 *    file reads back every field exactly (nested lists, the
 *    budget-usage record, optional fields present-or-absent), so a
 *    CheckpointLog over the reopened store resumes from the persisted
 *    latest checkpoint;
 *  - copy contract: rows are re-read and JSON-parsed per call, so a
 *    mutated read-back cannot corrupt the stored checkpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointLog,
  InMemoryCheckpointStore,
  createCheckpointV2,
  type CheckpointStore,
  type CheckpointV2,
} from '@ai-factory/runtime';
import { FactoryDatabase, SCHEMA, SqliteCheckpointStore } from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-ckpt-'));
  return { dir, file: join(dir, 'factory.db') };
}

const CLOCK = { now: () => 42_000 };

function full(runId: string, stepPosition: number): CheckpointV2 {
  return createCheckpointV2(
    {
      runId,
      stepPosition,
      workflowVersion: 'wf@3',
      taskVersion: 'task@2',
      contextManifestHash: 'ctx-hash',
      modelSessionRef: 'sess-9',
      workspaceSnapshotHash: 'ws-hash',
      gitBase: 'base-sha',
      gitCandidate: 'cand-sha',
      activeTools: ['pytest'],
      activeProcesses: [1234],
      leaseGeneration: 4,
      fencingToken: 4,
      pendingApprovals: ['appr-1'],
      budgetUsage: { tokens: 1200, usd: 3 },
      pendingSideEffects: ['deploy:staging'],
      resumePreconditions: ['lease valid', 'policy unchanged'],
    },
    CLOCK,
  );
}

function minimal(runId: string, stepPosition: number): CheckpointV2 {
  return createCheckpointV2(
    {
      runId,
      stepPosition,
      workflowVersion: 'wf@1',
      taskVersion: 'task@1',
      contextManifestHash: 'ctx-min',
      activeTools: [],
      activeProcesses: [],
      leaseGeneration: 1,
      fencingToken: 1,
      pendingApprovals: [],
      budgetUsage: {},
      pendingSideEffects: [],
      resumePreconditions: [],
    },
    CLOCK,
  );
}

describe('SqliteCheckpointStore behavior parity (§28.3)', () => {
  it('the same scripted sequence yields identical results on memory and SQLite stores', () => {
    const sqlite = new DatabaseSync(':memory:');
    // The table normally comes from FactoryDatabase's SCHEMA exec; a bare
    // DatabaseSync needs the same DDL before the store is usable.
    sqlite.exec(SCHEMA);

    const mem: CheckpointStore = new InMemoryCheckpointStore();
    const sql: CheckpointStore = new SqliteCheckpointStore(sqlite);

    const trace: Array<{ mem: unknown; sql: unknown }> = [];
    const both = (fn: (s: CheckpointStore) => unknown): void => {
      trace.push({ mem: fn(mem), sql: fn(sql) });
    };

    both((s) => s.put(full('run-1', 7)));
    both((s) => s.put(minimal('run-1', 8)));
    both((s) => s.get('run-1', 7));
    both((s) => s.get('run-1', 99));
    // Re-capture at the same position replaces, position in list kept.
    both((s) => s.put({ ...full('run-1', 7), fencingToken: 9, leaseGeneration: 9 }));
    both((s) => s.put(minimal('run-2', 7)));
    both((s) => s.list());
    both((s) => s.list('run-1'));
    both((s) => s.delete('run-1', 8));
    both((s) => s.delete('run-1', 8));
    both((s) => s.list());

    for (const step of trace) assert.deepEqual(step.sql, step.mem);
    sqlite.close();
  });

  it('hands back fresh deep copies: mutating a read-back cannot corrupt the stored row', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA);
    const store = new SqliteCheckpointStore(sqlite);
    store.put(full('run-1', 7));
    const got = store.get('run-1', 7);
    got!.activeTools.push('evil');
    got!.budgetUsage.tokens = -1;
    got!.pendingSideEffects.length = 0;
    const again = store.get('run-1', 7);
    assert.deepEqual(again, full('run-1', 7));
    sqlite.close();
  });
});

describe('SqliteCheckpointStore durability (§28.3)', () => {
  it('round-trips every field across instances; CheckpointLog resumes from the persisted latest', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      const log1 = new CheckpointLog({ clock: CLOCK, store: fdb1.checkpoints });
      log1.record(full('run-1', 7));
      log1.record(minimal('run-1', 12));
      log1.record(full('run-2', 3));
      const before = log1.list();
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const log2 = new CheckpointLog({ store: fdb2.checkpoints });
        // Field-for-field across the restart: nested lists, the
        // budget-usage record, generations, capturedAt.
        assert.deepEqual(log2.list(), before);
        const latest = log2.latest('run-1');
        assert.equal(latest?.stepPosition, 12);
        assert.deepEqual(latest, minimal('run-1', 12));
        // Optional fields: present exactly where the capture set them,
        // ABSENT (no key at all) where it did not — never invented.
        const fullBack = log2.get('run-1', 7);
        assert.equal(fullBack?.modelSessionRef, 'sess-9');
        assert.equal(fullBack?.gitCandidate, 'cand-sha');
        const minBack = log2.get('run-1', 12);
        assert.equal('modelSessionRef' in (minBack ?? {}), false);
        assert.equal('workspaceSnapshotHash' in (minBack ?? {}), false);
        assert.equal('gitBase' in (minBack ?? {}), false);
        // Replace + delete survive the restart boundary too.
        log2.record({ ...full('run-1', 7), fencingToken: 21 });
        assert.equal(log2.remove('run-2', 3), true);
      } finally {
        fdb2.close();
      }

      const fdb3 = new FactoryDatabase(file);
      try {
        const log3 = new CheckpointLog({ store: fdb3.checkpoints });
        assert.equal(log3.get('run-1', 7)?.fencingToken, 21);
        assert.equal(log3.get('run-2', 3), undefined);
        assert.equal(log3.list().length, 2);
      } finally {
        fdb3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-G-59 database (no checkpoints table) gains it on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[]
        ).map((c) => c.name);
        for (const c of [
          'run_id', 'step_position', 'schema_version', 'context_manifest_hash',
          'active_tools', 'budget_usage', 'lease_generation', 'fencing_token',
          'captured_at',
        ]) {
          assert.ok(cols.includes(c), `checkpoints gains ${c}`);
        }
        const log = new CheckpointLog({ clock: CLOCK, store: fdb.checkpoints });
        const c = log.capture({
          runId: 'run-9',
          stepPosition: 1,
          workflowVersion: 'wf@1',
          taskVersion: 'task@1',
          contextManifestHash: 'ctx',
          activeTools: [],
          activeProcesses: [],
          leaseGeneration: 1,
          fencingToken: 1,
          pendingApprovals: [],
          budgetUsage: {},
          pendingSideEffects: [],
          resumePreconditions: [],
        });
        assert.equal(log.latest('run-9')?.capturedAt, c.capturedAt);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
