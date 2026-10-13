/**
 * Pipeline record + stage definition persistence — SPEC v2 §39/§40
 * (Batch 31-2).
 *
 * One scripted sequence, run identically against the in-memory
 * reference and the SQLite implementation:
 *  - save/get round-trips the record field-for-field, including all
 *    12 stages in canonical order with logs/artifacts/timestamps;
 *  - save is a whole-record upsert: re-saving with changed statuses
 *    REPLACES the old stage rows (no stale stage rows survive);
 *  - list() returns all records, copy contract holds;
 *  - a corrupted stages row fails loudly (never silently normalized);
 *  - rows survive a database reopen; the tables are created on old
 *    database files that predate them.
 *
 * Honest boundary pinned here: what is persisted is the RECORD, not
 * the run — stage handlers are host closures and are never
 * persistable (by design, like Batch 19's deployFn/smokeFn).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  InMemoryPipelineRecordStore,
  makePersistedPipeline,
  type PersistedPipeline,
  type PipelineRecordStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-pipelines-'));
  return { dir, file: join(dir, 'factory.db') };
}

function script(store: PipelineRecordStore): void {
  // Unknown id reads undefined; markRehydrated on unknown is a no-op.
  assert.equal(store.get('nope'), undefined);
  store.markRehydrated('nope', new Date().toISOString());

  // save/get round-trip, field for field, all 12 stages in order.
  const rec = makePersistedPipeline({
    id: 'pipe-1',
    commitSha: 'abc123',
    environment: 'DEV',
    taskId: 'task-7',
  });
  rec.stages[0].status = 'SUCCEEDED';
  rec.stages[0].logs = ['[build] ok'];
  rec.stages[0].artifacts = [{ name: 'build-result.json', kind: 'build-report', summary: 'ok' }];
  rec.stages[0].startedAt = '2026-10-13T00:00:01.000Z';
  rec.stages[0].endedAt = '2026-10-13T00:00:02.000Z';
  rec.stages[1].status = 'RUNNING';
  rec.stages[1].startedAt = '2026-10-13T00:00:03.000Z';
  store.save({ ...rec, status: 'RUNNING' });

  const back = store.get('pipe-1');
  assert.ok(back, 'saved record is readable');
  assert.equal(back?.id, 'pipe-1');
  assert.equal(back?.commitSha, 'abc123');
  assert.equal(back?.environment, 'DEV');
  assert.equal(back?.status, 'RUNNING');
  assert.equal(back?.taskId, 'task-7');
  assert.equal(back?.stages.length, 12, 'all 12 stage definitions persisted');
  assert.deepEqual(
    back?.stages.map((s) => s.name),
    [
      'build', 'test', 'lint', 'typecheck', 'security', 'package',
      'artifact', 'review_gate', 'uat', 'release', 'smoke', 'recovery',
    ],
    'stages come back in canonical position order',
  );
  assert.deepEqual(
    back?.stages.map((s) => s.position),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  const build = back?.stages[0];
  assert.equal(build?.status, 'SUCCEEDED');
  assert.deepEqual(build?.logs, ['[build] ok']);
  assert.deepEqual(build?.artifacts, [{ name: 'build-result.json', kind: 'build-report', summary: 'ok' }]);
  assert.equal(build?.startedAt, '2026-10-13T00:00:01.000Z');
  assert.equal(build?.endedAt, '2026-10-13T00:00:02.000Z');
  assert.equal(back?.stages[1].status, 'RUNNING');
  assert.equal(back?.stages[11].status, 'PENDING');

  // Whole-record upsert: old stage rows are REPLACED, never merged.
  const updated: PersistedPipeline = {
    ...makePersistedPipeline({ id: 'pipe-1' }),
    status: 'FAILED',
    failureStage: 'test',
    failureMessage: 'tests red',
  };
  updated.stages[1].status = 'FAILED';
  updated.stages[1].error = 'tests red';
  store.save(updated);
  const back2 = store.get('pipe-1');
  assert.equal(back2?.status, 'FAILED');
  assert.equal(back2?.failureStage, 'test');
  assert.equal(back2?.failureMessage, 'tests red');
  assert.equal(back2?.stages.length, 12, 'no stale stage rows survive a re-save');
  assert.equal(back2?.stages[0].status, 'PENDING', 'old SUCCEEDED row was replaced, not merged');
  assert.equal(back2?.stages[1].status, 'FAILED');
  assert.equal(back2?.stages[1].error, 'tests red');

  // list() returns every record.
  store.save(makePersistedPipeline({ id: 'pipe-2', environment: 'PROD' }));
  const ids = store.list().map((r) => r.id);
  assert.ok(ids.includes('pipe-1') && ids.includes('pipe-2'));
  assert.equal(store.list().find((r) => r.id === 'pipe-2')?.stages.length, 12);

  // Copy contract: mutating a fetched record cannot corrupt the store.
  const fetched = store.get('pipe-2')!;
  (fetched as { status: string }).status = 'HACKED';
  fetched.stages[0].status = 'HACKED' as never;
  const refetched = store.get('pipe-2')!;
  assert.equal(refetched.status, 'QUEUED');
  assert.equal(refetched.stages[0].status, 'PENDING');

  // markRehydrated stamps the rebuild marker.
  store.markRehydrated('pipe-1', '2026-10-13T00:01:00.000Z');
  assert.equal(store.get('pipe-1')?.rehydratedAt, '2026-10-13T00:01:00.000Z');
}

describe('pipeline record store (Batch 31-2)', () => {
  it('in-memory reference: full script', () => {
    script(new InMemoryPipelineRecordStore());
  });

  it('sqlite: full script (pinned against the in-memory reference)', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        script(fdb.pipelineRecords);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: a corrupted stages row fails loudly, never silently normalized', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        fdb.pipelineRecords.save(makePersistedPipeline({ id: 'pipe-c' }));
        const raw = new DatabaseSync(file);
        raw
          .prepare("UPDATE pipeline_stages SET logs_json = 'not-json{{{' WHERE pipeline_id = 'pipe-c' AND position = 0")
          .run();
        raw.close();
        assert.throws(() => fdb.pipelineRecords.get('pipe-c'), /corrupted pipeline_stages row/);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: rows survive a database reopen; tables are created on old files', () => {
    const { dir, file } = tmpDbFile();
    try {
      // An "old" database file: full schema, but predating the
      // Batch-31 pipeline tables (drop them, then reopen).
      {
        const fdb = new FactoryDatabase(file);
        fdb.close();
      }
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE pipeline_stages; DROP TABLE pipeline_records;');
      raw.close();
      {
        const reopened = new FactoryDatabase(file);
        reopened.pipelineRecords.save(makePersistedPipeline({ id: 'pipe-old' }));
        const back = reopened.pipelineRecords.get('pipe-old');
        assert.equal(back?.id, 'pipe-old');
        assert.equal(back?.stages.length, 12);
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: a failed save rolls back the whole unit (no half-written record)', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const good = makePersistedPipeline({ id: 'pipe-atomic' });
        good.stages[0].status = 'SUCCEEDED';
        fdb.pipelineRecords.save(good);

        // Force a mid-transaction failure: a NULL name violates the
        // NOT NULL column. The whole unit must roll back.
        const bad = makePersistedPipeline({ id: 'pipe-atomic' });
        (bad.stages[5] as { name: string | null }).name = null;
        assert.throws(() => fdb.pipelineRecords.save(bad), /NOT NULL/);

        const back = fdb.pipelineRecords.get('pipe-atomic');
        assert.equal(back?.stages.length, 12, 'no half-written stage rows');
        assert.equal(back?.stages[0].status, 'SUCCEEDED', 'old record intact');
        assert.equal(back?.stages[5].name, 'package');
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
