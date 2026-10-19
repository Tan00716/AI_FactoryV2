/**
 * CheckpointLog.count() — /api/health perf regression (H5 soak follow-up).
 *
 * Health needs only the number of stored checkpoints; count() must agree
 * with list().length without materializing rows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckpointLog,
  InMemoryCheckpointStore,
  createCheckpointV2,
} from '../src/index';

const CLOCK = { now: () => 42_000 };

function input(runId: string, stepPosition: number) {
  return {
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
  };
}

describe('CheckpointLog.count', () => {
  it('agrees with list().length, with and without a run filter', () => {
    const log = new CheckpointLog();
    log.capture(input('run-a', 0));
    log.capture(input('run-a', 1));
    log.capture(input('run-b', 0));
    assert.equal(log.count(), 3);
    assert.equal(log.count('run-a'), 2);
    assert.equal(log.count('run-b'), 1);
    assert.equal(log.count('run-missing'), 0);
    assert.equal(log.count(), log.list().length);
  });

  it('in-memory store count() matches', () => {
    const store = new InMemoryCheckpointStore();
    store.put(createCheckpointV2(input('r1', 0), CLOCK));
    store.put(createCheckpointV2(input('r1', 1), CLOCK));
    assert.equal(store.count(), 2);
    assert.equal(store.count('r1'), 2);
  });
});
