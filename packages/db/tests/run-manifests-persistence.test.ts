/**
 * Durable run manifests — Batch 15.
 *
 * The manifest is a run's accountability record: the runtime route
 * writes a creation snapshot (identity, driver, grant, budget
 * limits, context hash) and replaces it once at the run's terminal
 * write with the completion accounting. It sits behind the
 * RunManifestStore seam (packages/db/src/run-manifests.ts — the seam
 * lives in this package because the manifest is the route's
 * accountability projection, not a runtime domain type), and this
 * file pins the SQLite implementation (run_manifests table):
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results
 *    at every step — upsert identity (the run id),
 *    replace-keeps-position, first-put order, unknown id → undefined;
 *  - stepwise fidelity across instances: the route's write pattern
 *    (creation snapshot → completion replace) is replayed with the
 *    database closed and reopened between steps — each reopened
 *    FactoryDatabase reads back the last persisted state
 *    field-for-field, including a manifest left at its creation
 *    snapshot (status RUNNING, completion fields null: the honest
 *    state of an interrupted run, never retroactively finalized);
 *  - copy contract: mutating a fetched manifest, or the input
 *    after put(), cannot corrupt stored state, in either
 *    implementation;
 *  - old databases: a file that predates the run_manifests table
 *    gains it on open (CREATE TABLE IF NOT EXISTS in SCHEMA).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  InMemoryRunManifestStore,
  SCHEMA,
  SqliteRunManifestStore,
  type RunManifest,
  type RunManifestStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-manifests-'));
  return { dir, file: join(dir, 'factory.db') };
}

/** A creation-time manifest, exactly as the route builds it. */
function freshManifest(runId: string): RunManifest {
  return {
    runId,
    agentId: 'agent-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    createdAt: '2026-10-12T10:00:00.000Z',
    driver: { kind: 'script', adapter: 'stub', routeRequestProvided: false },
    grantedTools: ['echo'],
    budgetLimits: {
      loop: { maxSteps: 40, timeMs: 60_000, maxRetries: 3 },
      extended: { maxSteps: 60, maxModelCalls: 40, maxToolCalls: 120 },
    },
    contextManifestHash: 'a'.repeat(64),
    status: 'RUNNING',
    outcome: null,
    finishedAt: null,
    error: null,
    steps: null,
    model: null,
    modelSource: null,
    budgetUsage: null,
    intents: null,
    evidence: null,
    checkpoints: null,
  };
}

/** The same manifest after its terminal write. */
function completedManifest(runId: string): RunManifest {
  return {
    ...freshManifest(runId),
    status: 'COMPLETED',
    outcome: 'completed',
    finishedAt: '2026-10-12T10:00:05.000Z',
    steps: 6,
    model: 'stub',
    modelSource: 'adapter',
    budgetUsage: { modelCalls: 1, toolCalls: 1, repairLoops: 0, noProgressSteps: 0, elapsedMs: 42 },
    intents: {
      total: 2,
      ids: ['intent-1', 'intent-2'],
      byStatus: { PENDING: 0, EXECUTED: 1, FAILED: 0, DENIED: 1 },
    },
    evidence: { count: 3, byType: { context: 1, tool_result: 1, verify: 1 } },
    checkpoints: { count: 6, firstStep: 1, lastStep: 6 },
  };
}

describe('SqliteRunManifestStore behavior parity (Batch 15)', () => {
  it('the same scripted sequence yields identical results on memory and SQLite stores', () => {
    const sqlite = new DatabaseSync(':memory:');
    // The table normally comes from FactoryDatabase's SCHEMA exec; a
    // bare DatabaseSync needs the same DDL before the store is usable.
    sqlite.exec(SCHEMA);

    const mem: RunManifestStore = new InMemoryRunManifestStore();
    const sql: RunManifestStore = new SqliteRunManifestStore(sqlite);

    const trace: Array<{ mem: unknown; sql: unknown }> = [];
    const both = (fn: (s: RunManifestStore) => unknown): void => {
      trace.push({ mem: fn(mem), sql: fn(sql) });
    };

    both((s) => s.get('run-1'));
    both((s) => s.put(freshManifest('run-1')));
    both((s) => s.get('run-1'));
    both((s) => s.put(freshManifest('run-2')));
    // The terminal replace: same id, position in list kept.
    both((s) => s.put(completedManifest('run-1')));
    both((s) => s.get('run-1'));
    both((s) => s.list());
    both((s) => s.get('no-such-run'));

    for (const step of trace) assert.deepEqual(step.sql, step.mem);
    sqlite.close();
  });

  it('hands back fresh deep copies: mutating a read-back or a put input cannot corrupt the stored row', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA);
    const store = new SqliteRunManifestStore(sqlite);

    const input = completedManifest('run-1');
    store.put(input);
    input.grantedTools.push('evil');
    input.intents!.ids.push('evil');
    const got = store.get('run-1');
    got!.grantedTools.push('evil');
    got!.budgetLimits.extended['maxSteps'] = -1;
    got!.evidence!.byType['context'] = 99;

    assert.deepEqual(store.get('run-1'), completedManifest('run-1'));
    sqlite.close();
  });
});

describe('SqliteRunManifestStore durability (Batch 15)', () => {
  it('round-trips creation and completion states across instances, field-for-field', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      fdb1.runManifests.put(freshManifest('run-1'));
      fdb1.runManifests.put(completedManifest('run-2'));
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        // The interrupted run's manifest: still its creation
        // snapshot — RUNNING, every completion field null.
        const interrupted = fdb2.runManifests.get('run-1');
        assert.deepEqual(interrupted, freshManifest('run-1'));
        assert.equal(interrupted?.status, 'RUNNING');
        assert.equal(interrupted?.intents, null);
        assert.equal(interrupted?.checkpoints, null);
        // The completed run: every block intact, incl. the DENIED
        // bucket and the checkpoint range.
        assert.deepEqual(fdb2.runManifests.get('run-2'), completedManifest('run-2'));
        assert.equal(fdb2.runManifests.list().length, 2);
        // The terminal replace lands durably too.
        fdb2.runManifests.put(completedManifest('run-1'));
      } finally {
        fdb2.close();
      }

      const fdb3 = new FactoryDatabase(file);
      try {
        assert.deepEqual(fdb3.runManifests.get('run-1'), completedManifest('run-1'));
      } finally {
        fdb3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-manifest database (no run_manifests table) gains it on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(run_manifests)').all() as { name: string }[]
        ).map((c) => c.name);
        for (const c of [
          'run_id', 'agent_id', 'task_id', 'project_id', 'created_at',
          'driver', 'granted_tools', 'budget_limits', 'context_manifest_hash',
          'status', 'outcome', 'finished_at', 'error', 'steps', 'model',
          'model_source', 'budget_usage', 'intents', 'evidence', 'checkpoints',
        ]) {
          assert.ok(cols.includes(c), `run_manifests gains ${c}`);
        }
        fdb.runManifests.put(freshManifest('run-9'));
        assert.deepEqual(fdb.runManifests.get('run-9'), freshManifest('run-9'));
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
