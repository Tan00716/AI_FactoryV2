/**
 * Tests for @ai-factory/db key transactions — SPEC v2 §48.4.
 *
 * Each script is exercised with injectable fakes: the happy path commits
 * every step's outbox events; a failing step aborts with TxAbortError
 * naming the step and commits NOTHING (no partial commit).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignStartScript,
  authorizeTaskScript,
  deployScript,
  newTxContext,
  runTxScript,
  transitionScript,
  TxAbortError,
  type AssignStartDeps,
  type AuthorizeTaskDeps,
  type DeployDeps,
  type TransitionDeps,
} from '../src/index';

let seq = 0;
const deps = {
  newEventId: () => `evt-${++seq}`,
  nowIso: () => '2026-10-10T00:00:00.000Z',
};

describe('authorizeTask (§48.4)', () => {
  const base: AuthorizeTaskDeps = {
    ...deps,
    checkHumanAuthority: () => {},
    pinRootAuthorization: (input) => ({ id: `root-${input.taskId}`, scope: input.scope }),
    bumpTaskVersion: () => 2,
  };

  it('commits all steps and outbox events on success', () => {
    const steps = authorizeTaskScript(base, {
      taskId: 't1', humanId: 'h1', orgId: 'o1', projectId: 'p1', scope: 's',
    });
    const outbox = runTxScript('authorizeTask', steps, newTxContext());
    assert.equal(outbox.length, 2);
    assert.deepEqual(outbox.map((e) => e.event_type), ['AUTHORIZATION_PINNED', 'TASK_VERSIONED']);
  });

  it('aborts with no partial commit when authority check fails', () => {
    const bad: AuthorizeTaskDeps = {
      ...base,
      checkHumanAuthority: () => { throw new Error('UNAUTHORIZED: not a dispatcher'); },
    };
    const steps = authorizeTaskScript(bad, {
      taskId: 't1', humanId: 'hX', orgId: 'o1', projectId: 'p1', scope: 's',
    });
    const ctx = newTxContext();
    assert.throws(() => runTxScript('authorizeTask', steps, ctx), (e: unknown) => {
      assert.ok(e instanceof TxAbortError);
      assert.equal((e as TxAbortError).stepName, 'check-human-authority');
      return true;
    });
    assert.equal(ctx.outbox.length, 0, 'no partial commit');
  });
});

describe('assignStart (§48.4)', () => {
  function make(over: Partial<AssignStartDeps> = {}): AssignStartDeps {
    return {
      ...deps,
      checkAuthorization: () => {},
      checkDependenciesReady: () => {},
      checkCapability: () => {},
      reserveBudget: () => {},
      acquireWriterLease: () => 42,
      createRun: () => {},
      createDelegation: () => {},
      ...over,
    };
  }
  const input = {
    taskId: 't1', runId: 'r1', delegationId: 'd1', orgId: 'o1', projectId: 'p1',
    expectedTaskVersion: 2, envelopeId: 'env1', reservationId: 'res1',
    budgetMinor: 100, resourceId: 'ws-1', capabilityRef: 'cap-1', ttlMs: 60_000,
  };

  it('runs the full chain: authz → deps → capability → budget → lease → run → delegation', () => {
    const order: string[] = [];
    const d = make({
      checkAuthorization: () => { order.push('authz'); },
      reserveBudget: () => { order.push('budget'); },
      acquireWriterLease: () => { order.push('lease'); return 7; },
    });
    const outbox = runTxScript('assignStart', assignStartScript(d, input), newTxContext());
    assert.deepEqual(order, ['authz', 'budget', 'lease']);
    assert.ok(outbox.some((e) => e.event_type === 'LEASE_ACQUIRED' && e.payload['fencingToken'] === 7));
    assert.ok(outbox.some((e) => e.event_type === 'RUN_CREATED'));
    assert.ok(outbox.some((e) => e.event_type === 'DELEGATION_CREATED'));
  });

  it('a lease conflict aborts before run/delegation are created', () => {
    const created: string[] = [];
    const d = make({
      acquireWriterLease: () => { throw new Error('resource held by run-9'); },
      createRun: () => { created.push('run'); },
      createDelegation: () => { created.push('delegation'); },
    });
    const ctx = newTxContext();
    assert.throws(() => runTxScript('assignStart', assignStartScript(d, input), ctx), (e: unknown) => {
      assert.ok(e instanceof TxAbortError);
      assert.equal((e as TxAbortError).stepName, 'acquire-lease');
      return true;
    });
    assert.deepEqual(created, [], 'no run/delegation after lease failure');
    assert.equal(ctx.outbox.length, 0);
  });
});

describe('transition (§48.4)', () => {
  function make(over: Partial<TransitionDeps> = {}): TransitionDeps {
    return {
      ...deps,
      checkExpectedVersion: (_t, v) => v,
      loadGates: () => [{ id: 'g1', verdict: 'PASSED' }],
      checkApprovals: () => {},
      checkArtifacts: () => {},
      policyCheck: () => {},
      applyState: () => {},
      invalidateMilestones: () => ['VERIFIED'],
      invalidateProgress: () => {},
      ...over,
    };
  }
  const input = { taskId: 't1', expectedVersion: 3, from: 'QA', to: 'PENDING_UAT_MERGE' };

  it('checks version, gates, approvals, artifacts, policy — then invalidates', () => {
    const outbox = runTxScript('transition', transitionScript(make(), input), newTxContext());
    assert.ok(outbox.some((e) => e.event_type === 'TASK_TRANSITIONED'));
  });

  it('stale expected version aborts as VERSION_CONFLICT', () => {
    const d = make({ checkExpectedVersion: () => 4 });
    assert.throws(
      () => runTxScript('transition', transitionScript(d, input), newTxContext()),
      /VERSION_CONFLICT/,
    );
  });

  it('failed gates abort before state is applied', () => {
    let applied = false;
    const d = make({
      loadGates: () => [{ id: 'g1', verdict: 'FAILED' }],
      applyState: () => { applied = true; },
    });
    assert.throws(() => runTxScript('transition', transitionScript(d, input), newTxContext()), /not satisfied/);
    assert.equal(applied, false);
  });
});

describe('deploy (§48.4)', () => {
  function make(over: Partial<DeployDeps> = {}): DeployDeps {
    const seen = new Map<string, string>();
    return {
      ...deps,
      registerIdempotencyKey: (k, op) => {
        const prev = seen.get(k);
        if (!prev) { seen.set(k, op); return 'NEW'; }
        return prev === op ? 'SEEN_SAME' : 'SEEN_DIFFERENT';
      },
      acquireDeployLease: () => 11,
      checkApprovedDigest: (a, b) => {
        if (a !== b) throw new Error('APPROVAL_REQUIRED: digest mismatch');
      },
      brokerExecute: () => 'CONFIRMED_SUCCEEDED',
      recordOperationResult: () => {},
      reconcile: () => {},
      ...over,
    };
  }
  const input = {
    operationId: 'op1', idempotencyKey: 'key-1', taskId: 't1',
    artifactDigest: 'd1', approvedDigest: 'd1', environment: 'prod',
    resourceId: 'prod-env', runId: 'r1', ttlMs: 60_000,
  };

  it('deploys with idempotency key, lease, digest check, and reconciliation', () => {
    const outbox = runTxScript('deploy', deployScript(make(), input), newTxContext());
    const types = outbox.map((e) => e.event_type);
    assert.ok(types.includes('EXTERNAL_OP_PREPARED'));
    assert.ok(types.includes('EXTERNAL_OP_RECORDED'));
  });

  it('same key + different payload refuses the second action', () => {
    const d = make();
    runTxScript('deploy', deployScript(d, input), newTxContext());
    const evil = { ...input, operationId: 'op2', artifactDigest: 'd-EVIL', approvedDigest: 'd-EVIL' };
    assert.throws(
      () => runTxScript('deploy', deployScript(d, evil), newTxContext()),
      /different payload/,
    );
  });

  it('digest mismatch aborts before the broker executes', () => {
    let executed = false;
    const d = make({ brokerExecute: () => { executed = true; return 'CONFIRMED_SUCCEEDED'; } });
    const bad = { ...input, artifactDigest: 'd2' };
    assert.throws(() => runTxScript('deploy', deployScript(d, bad), newTxContext()), /digest mismatch/);
    assert.equal(executed, false);
  });

  it('UNKNOWN results are recorded and reconciled, never blindly replayed', () => {
    let reconciled: unknown = null;
    const d = make({
      brokerExecute: () => 'UNKNOWN',
      reconcile: (_op, result) => { reconciled = result; },
    });
    const outbox = runTxScript('deploy', deployScript(d, input), newTxContext());
    assert.ok(outbox.some((e) => e.event_type === 'EXTERNAL_OP_UNKNOWN'));
    assert.equal(reconciled, 'UNKNOWN');
  });
});
