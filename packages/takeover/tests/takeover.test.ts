import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager } from '@ai-factory/leases';
import {
  IllegalTakeoverTransition,
  SilentOverwriteRefused,
  TakeoverError,
  TakeoverManager,
  WriterNotQuiet,
  assertWriterQuiet,
  type TakeoverHooks,
} from '../src/index';

function hooks(over: Partial<TakeoverHooks> = {}): TakeoverHooks {
  return {
    quiesceWorker: async () => {},
    noUncontrolledWrites: async () => true,
    snapshot: async (runId) => `snap:${runId}`,
    threeWayMerge: async (files) => files.map((f) => `${f}:merged`),
    revalidateEvidence: async (ids) => ids.map((id) => `${id}:revalidated`),
    ...over,
  };
}

function setup(over: Partial<TakeoverHooks> = {}) {
  const leases = new LeaseManager({ now: () => 1_000 });
  const mgr = new TakeoverManager(leases, hooks(over));
  // The AI worker holds the workspace lease before takeover.
  const aiLease = leases.acquire('ws:proj', 'run-ai-1', 600_000);
  return { leases, mgr, aiLease };
}

describe('takeover flow (§31)', () => {
  it('walks the full flow: quiesce → fence → verify → snapshot → human → return → resume', async () => {
    const { mgr } = setup();
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    assert.equal(mgr.display(t0.id), 'TAKEOVER_PENDING');

    const t1 = await mgr.acquireControl(t0.id);
    assert.equal(t1.state, 'HUMAN_OWNED');
    assert.equal(t1.fencedGeneration, 2); // generation bumped past the AI worker's
    assert.equal(mgr.display(t0.id), 'CONTROL_ACQUIRED');

    const t2 = mgr.applyHumanEdit(t0.id, {
      authorId: 'human:tan',
      baseRevision: t1.snapshotRef as string,
      fileHashes: { 'src/app.ts': 'hash-new' },
      diff: '+ fixed race',
    });
    assert.equal(t2.humanEdits[0].authorType, 'HUMAN');

    const t3 = await mgr.returnControl(t0.id, {
      overlappingFiles: ['src/app.ts'],
      affectedEvidenceIds: ['ev-1'],
    });
    assert.equal(t3.state, 'RESUMED');
    assert.deepEqual(t3.mergedFiles, ['src/app.ts:merged']);
    assert.deepEqual(t3.revalidatedEvidence, ['ev-1:revalidated']);
    assert.equal(mgr.display(t0.id), 'RETURNED');
    assert.ok(t3.completedAt !== null);
  });

  it('stays TAKEOVER_PENDING when the writer will not quiesce', async () => {
    const { mgr } = setup({ noUncontrolledWrites: async () => false });
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    const t1 = await mgr.acquireControl(t0.id);
    assert.equal(t1.state, 'FAILED');
    assert.match(t1.failureReason ?? '', /still in flight/);
    // Never a fake "acquired".
    assert.notEqual(mgr.display(t0.id), 'CONTROL_ACQUIRED');
  });

  it('a quiesce failure surfaces instead of proceeding', async () => {
    const { mgr } = setup({
      quiesceWorker: async () => {
        throw new Error('worker did not ack');
      },
    });
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    const t1 = await mgr.acquireControl(t0.id);
    assert.equal(t1.state, 'FAILED');
    assert.match(t1.failureReason ?? '', /quiesce failed/);
  });

  it('the fenced-out AI worker can no longer write (no silent overwrite)', async () => {
    const { leases, mgr, aiLease } = setup();
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    await mgr.acquireControl(t0.id);
    // The old AI token is dead.
    assert.throws(
      () => mgr.assertAiWriteAllowed('ws:proj', aiLease.fencing_token, 'src/app.ts'),
      SilentOverwriteRefused,
    );
    // The fresh post-return lease works.
    const fresh = leases.get('ws:proj');
    assert.ok(fresh);
    assert.doesNotThrow(() =>
      mgr.assertAiWriteAllowed('ws:proj', fresh.fencing_token, 'src/other.ts'),
    );
  });

  it('human edits are rejected outside HUMAN_OWNED and on a stale base', async () => {
    const { mgr } = setup();
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    assert.throws(
      () =>
        mgr.applyHumanEdit(t0.id, {
          authorId: 'h', baseRevision: 'x', fileHashes: {}, diff: '',
        }),
      TakeoverError,
    );
    await mgr.acquireControl(t0.id);
    const snap = mgr.get(t0.id).snapshotRef as string;
    assert.throws(
      () =>
        mgr.applyHumanEdit(t0.id, {
          authorId: 'h', baseRevision: 'wrong-base', fileHashes: {}, diff: '',
        }),
      (err: unknown) => (err as { code?: string }).code === 'STALE_EDIT_BASE',
    );
    assert.doesNotThrow(() =>
      mgr.applyHumanEdit(t0.id, {
        authorId: 'h', baseRevision: snap, fileHashes: {}, diff: '',
      }),
    );
  });

  it('illegal transitions throw', async () => {
    const { mgr } = setup();
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    await assert.rejects(mgr.returnControl(t0.id, { overlappingFiles: [], affectedEvidenceIds: [] }), (err: unknown) =>
      err instanceof IllegalTakeoverTransition,
    );
  });

  it('assertWriterQuiet surfaces instead of swallowing', () => {
    assert.throws(() => assertWriterQuiet(false, '2 writes in flight'), WriterNotQuiet);
    assert.doesNotThrow(() => assertWriterQuiet(true, ''));
  });

  it('cancel works before resume, not after', async () => {
    const { mgr } = setup();
    const t0 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    const c = mgr.cancel(t0.id, 'human changed mind');
    assert.equal(c.state, 'CANCELLED');
    const t1 = mgr.requestTakeover('run-ai-1', 'ws:proj', 'human:tan');
    await mgr.acquireControl(t1.id);
    await mgr.returnControl(t1.id, { overlappingFiles: [], affectedEvidenceIds: [] });
    assert.throws(() => mgr.cancel(t1.id, 'too late'), TakeoverError);
  });
});
