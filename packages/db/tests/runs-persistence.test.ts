/**
 * Durable HTTP run records — walkthrough F4 (Batch 12).
 *
 * The record POST /api/runtime/runs creates used to live in a
 * module-level Map in the server route: a restart lost it (GET 404)
 * even though the run's step intents and evidence were already durable.
 * It now sits behind the RuntimeRunStore seam (packages/db/src/runs.ts
 * — the seam lives in this package because the record is the route's
 * HTTP projection, not a runtime domain type), and this file pins the
 * SQLite implementation (runtime_runs table):
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results at
 *    every step — upsert identity (the run id), replace-keeps-position,
 *    first-put order, unknown id → undefined;
 *  - stepwise fidelity across instances: the route's write pattern
 *    (create RUNNING → evidence appended mid-run → terminal write) is
 *    replayed and the database is closed and reopened between steps —
 *    each reopened FactoryDatabase reads back the last persisted state
 *    field-for-field, including a record left RUNNING (the honest
 *    state of an interrupted run);
 *  - copy contract: mutating a fetched record, or the input after
 *    put(), cannot corrupt stored state, in either implementation;
 *  - old databases: a file that predates the runtime_runs table gains
 *    it on open (CREATE TABLE IF NOT EXISTS in SCHEMA).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  InMemoryRuntimeRunStore,
  SqliteRuntimeRunStore,
  type RuntimeRunRecord,
  type RuntimeRunStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-runs-'));
  return { dir, file: join(dir, 'factory.db') };
}

/** A freshly created run record, exactly as the route builds it. */
function freshRun(id: string): RuntimeRunRecord {
  return {
    id,
    agentId: 'agent-1',
    taskId: 'task-1',
    status: 'RUNNING',
    outcome: null,
    steps: 0,
    evidence: [],
    handoffs: [],
    trace: [],
    createdAt: '2026-10-12T10:00:00.000Z',
    finishedAt: null,
    error: null,
  };
}

/** A terminal record with every composite field populated. */
function finishedRun(id: string): RuntimeRunRecord {
  return {
    id,
    agentId: 'agent-2',
    taskId: 'task-9',
    status: 'COMPLETED',
    outcome: 'completed',
    steps: 3,
    evidence: [
      { type: 'tool_result', title: 'tool echo ok', payload: { tool: 'echo', ok: true } },
      { type: 'note', title: 'done', payload: { nested: { list: [1, 'two', null] } } },
    ],
    handoffs: ['agent-3'],
    trace: [{ phase: 'ACT', action: 'tool:echo', result: 'ok' }, 'plain-entry'],
    createdAt: '2026-10-12T10:00:00.000Z',
    finishedAt: '2026-10-12T10:00:07.500Z',
    error: null,
  };
}

describe('RuntimeRunStore parity (in-memory vs SQLite)', () => {
  it('identical results at every step of a scripted sequence', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const stores: Array<[string, RuntimeRunStore]> = [
          ['memory', new InMemoryRuntimeRunStore()],
          ['sqlite', fdb.runs],
        ];
        // One script, run against both stores; snapshots must match
        // each other AND the expected values at every step.
        const script = (store: RuntimeRunStore): unknown[] => {
          const snaps: unknown[] = [];
          snaps.push(store.get('nope'));
          snaps.push(store.list());
          store.put(freshRun('r1'));
          store.put(finishedRun('r2'));
          snaps.push(store.get('r1'));
          snaps.push(store.list().map((r) => r.id));
          // Replace r1 with its terminal state: position must be kept.
          const r1Done: RuntimeRunRecord = {
            ...freshRun('r1'),
            status: 'FAILED',
            outcome: 'failed',
            steps: 1,
            error: 'boom',
            finishedAt: '2026-10-12T10:00:01.000Z',
          };
          store.put(r1Done);
          snaps.push(store.get('r1'));
          snaps.push(store.list().map((r) => r.id));
          snaps.push(store.list());
          return snaps;
        };
        const [memSnaps, sqlSnaps] = stores.map(([, s]) => script(s));
        assert.deepEqual(sqlSnaps, memSnaps);
        assert.equal((sqlSnaps[0] as unknown), undefined);
        assert.deepEqual(sqlSnaps[3], ['r1', 'r2']);
        assert.deepEqual(sqlSnaps[5], ['r1', 'r2']);
        assert.equal((sqlSnaps[4] as RuntimeRunRecord).status, 'FAILED');
        assert.equal((sqlSnaps[4] as RuntimeRunRecord).error, 'boom');
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
        const stores: RuntimeRunStore[] = [new InMemoryRuntimeRunStore(), fdb.runs];
        for (const store of stores) {
          const input = finishedRun('rx');
          store.put(input);
          // Mutating the caller's object after put must not leak in.
          input.steps = 999;
          (input.evidence as unknown[]).push({ forged: true });
          const read1 = store.get('rx');
          assert.equal(read1?.steps, 3);
          assert.equal(read1?.evidence.length, 2);
          // Mutating a fetched record must not corrupt stored state.
          read1!.steps = -1;
          (read1!.evidence as unknown[]).length = 0;
          const read2 = store.get('rx');
          assert.equal(read2?.steps, 3);
          assert.equal(read2?.evidence.length, 2);
          assert.deepEqual(read2, finishedRun('rx'));
        }
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteRuntimeRunStore across restarts', () => {
  it('the route write pattern survives a reopen between every step', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Step 1 — creation write (status RUNNING), then "process dies".
      const rec = freshRun('run-1');
      let fdb = new FactoryDatabase(file);
      fdb.runs.put(rec);
      fdb.close();

      // Step 2 — a new process sees the RUNNING record field-for-field;
      // evidence lands mid-run and is persisted as it is appended.
      fdb = new FactoryDatabase(file);
      assert.deepEqual(fdb.runs.get('run-1'), rec);
      rec.evidence.push({ type: 'tool_result', title: 'tool echo ok', payload: { tool: 'echo', ok: true } });
      fdb.runs.put(rec);
      fdb.close();

      // Step 3 — the appended evidence survived; the terminal write
      // lands and is read back exactly by a third process.
      fdb = new FactoryDatabase(file);
      const mid = fdb.runs.get('run-1');
      assert.equal(mid?.status, 'RUNNING');
      assert.equal(mid?.evidence.length, 1);
      const done: RuntimeRunRecord = {
        ...mid!,
        status: 'COMPLETED',
        outcome: 'completed',
        steps: 3,
        handoffs: ['agent-3'],
        trace: [{ phase: 'FINISH', outcome: 'completed', steps: 3 }],
        finishedAt: '2026-10-12T10:00:07.500Z',
      };
      fdb.runs.put(done);
      fdb.close();

      fdb = new FactoryDatabase(file);
      assert.deepEqual(fdb.runs.get('run-1'), done);
      assert.deepEqual(fdb.runs.list(), [done]);
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a database predating the runtime_runs table gains it on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      // A bare old file: one unrelated table, no factory schema at all.
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE legacy_thing (id TEXT)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = fdb.db
          .prepare('PRAGMA table_info(runtime_runs)')
          .all() as Array<{ name: string }>;
        assert.deepEqual(
          cols.map((c) => c.name),
          ['id', 'agent_id', 'task_id', 'status', 'outcome', 'steps',
           'evidence', 'handoffs', 'trace', 'created_at', 'finished_at', 'error'],
        );
        fdb.runs.put(finishedRun('old-db-run'));
        assert.deepEqual(fdb.runs.get('old-db-run'), finishedRun('old-db-run'));
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SqliteRuntimeRunStore can be driven directly on a raw connection', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      fdb.close();
      const raw = new DatabaseSync(file);
      try {
        const store = new SqliteRuntimeRunStore(raw);
        store.put(finishedRun('direct'));
        assert.deepEqual(store.get('direct'), finishedRun('direct'));
        assert.equal(store.list().length, 1);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
