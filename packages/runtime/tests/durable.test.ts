import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlindReplayRefused,
  createCheckpointV2,
  DiskFullError,
  EXTERNAL_OP_STATES,
  OperationLedger,
  StepIntentStore,
  StorageGuard,
  validateCheckpointV2,
} from '../src/index';

describe('external operations (§28.2)', () => {
  it('walks PREPARED → DISPATCHED → CONFIRMED', () => {
    const ledger = new OperationLedger({ now: () => 1_000 });
    const op = ledger.prepare({
      logicalAction: 'deploy:prod',
      candidateDigest: 'sha:abc',
      environment: 'prod',
      reversible: true,
    });
    assert.equal(op.state, 'PREPARED');
    assert.ok(op.idempotencyKey.length === 64);
    const d = ledger.dispatch(op.id);
    assert.equal(d.state, 'DISPATCHED');
    const c = ledger.confirm(op.id, true, 'deploy-123');
    assert.equal(c.state, 'CONFIRMED_SUCCEEDED');
    assert.equal(c.ledgerRef, 'deploy-123');
  });

  it('binds the idempotency key to action+candidate+environment', () => {
    const k1 = OperationLedger.idempotencyKey('deploy', 'sha:a', 'prod');
    const k2 = OperationLedger.idempotencyKey('deploy', 'sha:b', 'prod');
    const k3 = OperationLedger.idempotencyKey('deploy', 'sha:a', 'uat');
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    // Preparing the same logical action twice returns the same operation.
    const ledger = new OperationLedger();
    const a = ledger.prepare({ logicalAction: 'x', candidateDigest: 'c', environment: 'e', reversible: true });
    const b = ledger.prepare({ logicalAction: 'x', candidateDigest: 'c', environment: 'e', reversible: true });
    assert.equal(a.id, b.id);
  });

  it('reconcile adopts the target ledger instead of replaying', () => {
    const ledger = new OperationLedger();
    const op = ledger.prepare({ logicalAction: 'pr:create', candidateDigest: 'c1', environment: 'dev', reversible: true });
    ledger.dispatch(op.id);
    ledger.markUnknown(op.id, 'network timeout');
    const res = ledger.reconcile(op.id, {
      findByIdempotencyKey: () => ({ outcome: 'succeeded', ledgerRef: 'pr-42' }),
    });
    assert.equal(res.action, 'already-done');
    assert.equal(res.operation.state, 'CONFIRMED_SUCCEEDED');
    assert.equal(res.operation.ledgerRef, 'pr-42');
  });

  it('UNKNOWN + irreversible + target silent ⇒ needs-manual-recovery, never blind replay', () => {
    const ledger = new OperationLedger();
    const op = ledger.prepare({
      logicalAction: 'db:migrate:drop-column',
      candidateDigest: 'c1',
      environment: 'prod',
      reversible: false,
    });
    ledger.dispatch(op.id);
    ledger.markUnknown(op.id, 'process killed');
    const res = ledger.reconcile(op.id, { findByIdempotencyKey: () => undefined });
    assert.equal(res.action, 'needs-manual-recovery');
    assert.throws(() => ledger.assertReplayable(op.id, { findByIdempotencyKey: () => undefined }), BlindReplayRefused);
  });

  it('UNKNOWN + reversible + target silent ⇒ safe-to-retry with the same key', () => {
    const ledger = new OperationLedger();
    const op = ledger.prepare({ logicalAction: 'ci:run', candidateDigest: 'c1', environment: 'dev', reversible: true });
    ledger.dispatch(op.id);
    ledger.markUnknown(op.id, 'timeout');
    const res = ledger.reconcile(op.id, { findByIdempotencyKey: () => undefined });
    assert.equal(res.action, 'safe-to-retry');
    assert.equal(res.operation.idempotencyKey, op.idempotencyKey);
  });

  it('lists all five states', () => {
    assert.deepEqual([...EXTERNAL_OP_STATES], [
      'PREPARED', 'DISPATCHED', 'CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED', 'UNKNOWN',
    ]);
  });
});

describe('step intents (§28.1)', () => {
  it('persists intent before execution and commits the fact after', () => {
    const store = new StepIntentStore();
    const intent = store.persistIntent('run-1', 'shell', { cmd: 'pytest' }, 'cap-1');
    assert.equal(intent.status, 'PENDING');
    assert.equal(store.pendingIntents('run-1').length, 1);
    store.recordResult(intent.id, true, { exit: 0 });
    assert.equal(store.pendingIntents('run-1').length, 0);
  });
});

describe('checkpoints (§28.3)', () => {
  function full() {
    return createCheckpointV2({
      runId: 'run-1',
      stepPosition: 7,
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
    });
  }

  it('carries the full §28.3 field set', () => {
    const c = full();
    assert.equal(c.schemaVersion, '2.0');
    assert.equal(c.leaseGeneration, 4);
    assert.deepEqual(c.resumePreconditions, ['lease valid', 'policy unchanged']);
    assert.doesNotThrow(() => validateCheckpointV2(c));
  });

  it('rejects checkpoints missing required fields', () => {
    const c = { ...full(), fencingToken: undefined } as unknown as Record<string, unknown>;
    delete c.fencingToken;
    assert.throws(() => validateCheckpointV2(c), /fencingToken/);
  });
});

describe('disk safe-mode (§28.4)', () => {
  it('stops new dangerous side effects but keeps an emergency log', () => {
    const g = new StorageGuard();
    g.assertCanWrite(true, 'deploy'); // healthy: fine
    g.reportWritable(false);
    assert.throws(() => g.assertCanWrite(true, 'deploy prod'), DiskFullError);
    g.assertCanWrite(false, 'read status'); // reads still fine
    g.emergencyLogLine('worker-3 heartbeat lost at t=999');
    const log = g.drainEmergencyLog();
    assert.ok(log.some((l) => l.includes('REFUSED(disk-full): deploy prod')));
    assert.ok(log.some((l) => l.includes('heartbeat lost')));
  });
});
