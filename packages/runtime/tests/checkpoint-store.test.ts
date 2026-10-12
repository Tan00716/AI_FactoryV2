/**
 * CheckpointStore seam — SPEC v2 §28.3 (G-59).
 *
 * Checkpoints used to be bare values built by createCheckpointV2 with
 * nowhere durable to go: no store seam, no persistence point. They now
 * live behind the CheckpointStore interface (mirroring OperationStore),
 * with CheckpointLog as the runtime-side consumer (create → validate →
 * store, latest-position resume lookup). These tests pin the seam
 * itself: the copy contract (checkpoints carry NESTED state, so copies
 * must be deep), (runId, stepPosition) replace semantics, and behavior
 * parity between conforming stores.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckpointLog,
  InMemoryCheckpointStore,
  createCheckpointV2,
  type CheckpointStore,
  type CheckpointV2,
} from '../src/index';

const CLOCK = { now: () => 42_000 };

function fullInput(runId: string, stepPosition: number) {
  return {
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
    budgetUsage: { tokens: 1200 },
    pendingSideEffects: ['deploy:staging'],
    resumePreconditions: ['lease valid', 'policy unchanged'],
  };
}

function minimalInput(runId: string, stepPosition: number) {
  return {
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
  };
}

/** A second, independent CheckpointStore implementation (array-backed). */
class ArrayCheckpointStore implements CheckpointStore {
  readonly rows: CheckpointV2[] = [];
  get(runId: string, stepPosition: number): CheckpointV2 | undefined {
    const c = this.rows.find((r) => r.runId === runId && r.stepPosition === stepPosition);
    return c ? structuredClone(c) : undefined;
  }
  put(checkpoint: CheckpointV2): void {
    const i = this.rows.findIndex(
      (r) => r.runId === checkpoint.runId && r.stepPosition === checkpoint.stepPosition,
    );
    if (i >= 0) this.rows[i] = structuredClone(checkpoint);
    else this.rows.push(structuredClone(checkpoint));
  }
  list(runId?: string): CheckpointV2[] {
    return this.rows
      .filter((r) => runId === undefined || r.runId === runId)
      .map((r) => structuredClone(r));
  }
  delete(runId: string, stepPosition: number): boolean {
    const i = this.rows.findIndex((r) => r.runId === runId && r.stepPosition === stepPosition);
    if (i < 0) return false;
    this.rows.splice(i, 1);
    return true;
  }
}

describe('CheckpointStore seam (§28.3)', () => {
  it('put/get round-trips the full field set; unset optional fields stay absent', () => {
    const store = new InMemoryCheckpointStore();
    const full = createCheckpointV2(fullInput('run-1', 7), CLOCK);
    const minimal = createCheckpointV2(minimalInput('run-1', 8), CLOCK);
    store.put(full);
    store.put(minimal);
    assert.deepEqual(store.get('run-1', 7), full);
    const back = store.get('run-1', 8);
    assert.deepEqual(back, minimal);
    // Absent, never invented: no explicit undefined keys appear.
    assert.equal('modelSessionRef' in (back ?? {}), false);
    assert.equal('gitBase' in (back ?? {}), false);
    assert.equal(store.get('run-1', 99), undefined);
    assert.equal(store.get('no-such-run', 7), undefined);
  });

  it('hands back deep copies: mutating a returned checkpoint cannot corrupt the stored one', () => {
    const store = new InMemoryCheckpointStore();
    const original = createCheckpointV2(fullInput('run-1', 7), CLOCK);
    store.put(original);
    // Mutating the caller's object after put must not reach the store.
    original.activeTools.push('evil');
    original.budgetUsage.tokens = -1;
    const got = store.get('run-1', 7);
    assert.deepEqual(got?.activeTools, ['pytest']);
    assert.equal(got?.budgetUsage.tokens, 1200);
    // Mutating a returned copy (nested fields included) must not either.
    got!.activeProcesses.push(9999);
    got!.pendingApprovals.length = 0;
    const again = store.get('run-1', 7);
    assert.deepEqual(again?.activeProcesses, [1234]);
    assert.deepEqual(again?.pendingApprovals, ['appr-1']);
    // Same for list() results.
    const listed = store.list();
    listed[0].resumePreconditions.push('forged');
    assert.deepEqual(store.get('run-1', 7)?.resumePreconditions, [
      'lease valid',
      'policy unchanged',
    ]);
  });

  it('re-capturing the same (runId, stepPosition) replaces; other positions and runs are untouched', () => {
    const store = new InMemoryCheckpointStore();
    store.put(createCheckpointV2(fullInput('run-1', 7), CLOCK));
    store.put(createCheckpointV2(minimalInput('run-1', 8), CLOCK));
    store.put(createCheckpointV2(minimalInput('run-2', 7), CLOCK));
    const recapture = createCheckpointV2(
      { ...fullInput('run-1', 7), fencingToken: 9, leaseGeneration: 9 },
      { now: () => 50_000 },
    );
    store.put(recapture);
    assert.equal(store.list().length, 3);
    assert.deepEqual(store.get('run-1', 7), recapture);
    assert.equal(store.get('run-1', 7)?.fencingToken, 9);
    // First-capture order is kept even for the replaced entry.
    assert.deepEqual(
      store.list().map((c) => `${c.runId}@${c.stepPosition}`),
      ['run-1@7', 'run-1@8', 'run-2@7'],
    );
    assert.deepEqual(
      store.list('run-1').map((c) => c.stepPosition),
      [7, 8],
    );
  });

  it('delete removes exactly one capture and reports whether one existed', () => {
    const store = new InMemoryCheckpointStore();
    store.put(createCheckpointV2(fullInput('run-1', 7), CLOCK));
    assert.equal(store.delete('run-1', 7), true);
    assert.equal(store.get('run-1', 7), undefined);
    assert.equal(store.delete('run-1', 7), false);
    assert.equal(store.delete('no-such-run', 1), false);
  });
});

describe('CheckpointLog (§28.3)', () => {
  it('capture() stamps schemaVersion/capturedAt from the injected clock and stores the checkpoint', () => {
    const log = new CheckpointLog({ clock: CLOCK });
    const c = log.capture(fullInput('run-1', 7));
    assert.equal(c.schemaVersion, '2.0');
    assert.equal(c.capturedAt, 42_000);
    assert.deepEqual(log.get('run-1', 7), c);
  });

  it('record() refuses a checkpoint that would fail §28.3 validation, and stores nothing', () => {
    const log = new CheckpointLog({ clock: CLOCK });
    const bad = createCheckpointV2(fullInput('run-1', 7), CLOCK) as unknown as Record<
      string,
      unknown
    >;
    delete bad.fencingToken;
    assert.throws(() => log.record(bad as unknown as CheckpointV2), /fencingToken/);
    assert.equal(log.list().length, 0);
    assert.equal(log.get('run-1', 7), undefined);
  });

  it('latest() returns the highest captured step position per run', () => {
    const log = new CheckpointLog({ clock: CLOCK });
    assert.equal(log.latest('run-1'), undefined);
    log.capture(minimalInput('run-1', 3));
    log.capture(minimalInput('run-1', 9));
    log.capture(minimalInput('run-1', 5));
    log.capture(minimalInput('run-2', 100));
    assert.equal(log.latest('run-1')?.stepPosition, 9);
    assert.equal(log.latest('run-2')?.stepPosition, 100);
    // A re-capture at the top position supersedes the earlier one.
    log.capture({ ...minimalInput('run-1', 9), fencingToken: 77 });
    assert.equal(log.latest('run-1')?.fencingToken, 77);
    assert.equal(log.remove('run-1', 9), true);
    assert.equal(log.latest('run-1')?.stepPosition, 5);
  });

  it('an injected conforming store is the real backing: same script, same state', () => {
    const backing = new ArrayCheckpointStore();
    const a = new CheckpointLog({ clock: CLOCK, store: backing });
    const b = new CheckpointLog({ clock: CLOCK });
    const script = (log: CheckpointLog): void => {
      log.capture(fullInput('run-1', 7));
      log.capture(minimalInput('run-1', 8));
      log.capture({ ...fullInput('run-1', 7), fencingToken: 9 });
      log.capture(minimalInput('run-2', 1));
      log.remove('run-2', 1);
    };
    script(a);
    script(b);
    assert.deepEqual(a.list(), b.list());
    // The injected store saw every record — writes did not bypass it
    // (run-1@7 twice = one replaced row, run-1@8, run-2@1 removed ⇒ 2).
    assert.equal(backing.rows.length, 2);
    assert.deepEqual(backing.list(), b.list());
  });
});
