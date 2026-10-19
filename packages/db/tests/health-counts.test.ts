/**
 * /api/health perf regression — H5 soak follow-up.
 *
 * The desktop client polls /api/health every 10s. It used to report
 * table sizes via full list() materialization (a JSON.parse per
 * checkpoint/run row, N+1 version-payload queries per requirement),
 * which made p95 degrade as tables grew. This file pins the count-only
 * contract: the stores' count*() methods return exact numbers and never
 * call list().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  SqliteCheckpointStore,
  SqliteRequirementStore,
  SqliteRetentionStore,
  SqliteRuntimeRunStore,
  type RuntimeRunRecord,
} from '../src/index';
import {
  InMemoryRequirementStore,
  RequirementManager,
} from '@ai-factory/requirements';
import { createCheckpointV2 } from '@ai-factory/runtime';

const CLOCK = { now: () => 42_000 };

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-healthcount-'));
  return { dir, file: join(dir, 'factory.db') };
}

function checkpoint(runId: string, stepPosition: number) {
  return createCheckpointV2(
    {
      runId,
      stepPosition,
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
    },
    CLOCK,
  );
}

function runRecord(id: string): RuntimeRunRecord {
  return {
    id,
    agentId: 'agent-1',
    taskId: 'task-1',
    status: 'COMPLETED',
    outcome: 'completed',
    steps: 1,
    evidence: [],
    handoffs: [],
    trace: [],
    createdAt: '2026-10-19T00:00:00.000Z',
    finishedAt: '2026-10-19T00:00:01.000Z',
    error: null,
  };
}

/** Wrap a prototype method; count invocations without changing behavior. */
function spyCalls(proto: object, method: string): { calls(): number; restore(): void } {
  const rec = proto as Record<string, unknown>;
  const orig = rec[method] as (...args: never[]) => unknown;
  let n = 0;
  rec[method] = function (this: unknown, ...args: never[]): unknown {
    n += 1;
    return orig.apply(this, args);
  };
  return {
    calls: () => n,
    restore: () => {
      rec[method] = orig;
    },
  };
}

describe('health count-only contract (H5 soak perf fix)', () => {
  it('count*() returns exact numbers and never calls list()', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        // Seed: 3 checkpoints (2 on run-a), 2 requirements, 2 runs,
        // 2 legal holds with 1 released.
        fdb.checkpoints.put(checkpoint('run-a', 0));
        fdb.checkpoints.put(checkpoint('run-a', 1));
        fdb.checkpoints.put(checkpoint('run-b', 0));
        const reqMgr = new RequirementManager({ now: () => 42_000, store: fdb.requirements });
        reqMgr.create({
          businessGoal: 'g1',
          rationale: 'r1',
          acceptanceCriteria: [],
          createdBy: 'human',
        });
        reqMgr.create({
          businessGoal: 'g2',
          rationale: 'r2',
          acceptanceCriteria: [],
          createdBy: 'human',
        });
        fdb.runs.put(runRecord('run-1'));
        fdb.runs.put(runRecord('run-2'));
        fdb.retention.addHold({
          id: 'hold-1',
          scope: 'GLOBAL',
          projectId: null,
          reason: 'audit',
          setBy: 'human',
          setAt: '2026-10-19T00:00:00.000Z',
          releasedAt: null,
          releasedBy: null,
        });
        fdb.retention.addHold({
          id: 'hold-2',
          scope: 'GLOBAL',
          projectId: null,
          reason: 'audit',
          setBy: 'human',
          setAt: '2026-10-19T00:00:00.000Z',
          releasedAt: null,
          releasedBy: null,
        });
        fdb.retention.releaseHold('hold-2', 'human', '2026-10-19T01:00:00.000Z');

        // Install spies AFTER seeding: only the count*() calls below
        // may run, and none of them may touch list().
        const spies = [
          spyCalls(SqliteCheckpointStore.prototype, 'list'),
          spyCalls(SqliteRequirementStore.prototype, 'listRequirements'),
          spyCalls(SqliteRuntimeRunStore.prototype, 'list'),
          spyCalls(SqliteRetentionStore.prototype, 'listHolds'),
        ];
        try {
          // The exact calls /api/health now makes.
          assert.equal(fdb.checkpoints.count(), 3);
          assert.equal(fdb.checkpoints.count('run-a'), 2);
          assert.equal(fdb.checkpoints.count('run-b'), 1);
          assert.equal(fdb.requirements.countRequirements(), 2);
          assert.equal(fdb.runs.count(), 2);
          assert.equal(fdb.retention.countActiveHolds(), 1);

          for (const s of spies) assert.equal(s.calls(), 0);
        } finally {
          for (const s of spies) s.restore();
        }
      } finally {
        fdb.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in-memory stores agree on counts', () => {
    const mem = new InMemoryRequirementStore();
    const mgr = new RequirementManager({ now: () => 42_000, store: mem });
    mgr.create({ businessGoal: 'g', rationale: 'r', acceptanceCriteria: [], createdBy: 'human' });
    assert.equal(mem.countRequirements(), 1);
  });
});
