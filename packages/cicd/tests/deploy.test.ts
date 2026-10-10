/**
 * Tests for environments, the deploy flow, snapshots and rollback
 * (spec §40, §41, §77).
 * Run: node --test dist/tests/deploy.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalActionFor,
  ApprovalBlockedError,
  DeploymentNotPendingError,
  DeploymentService,
  DeployFnResult,
  ENVIRONMENTS,
  RollbackCapabilityError,
  SnapshotNotFoundError,
  SnapshotStore,
  approvalPolicyFor,
  evaluateApprovalPolicy,
  getEnvironment,
  rollback,
  type Environment,
} from '../src/index';

function devEnv(): Environment {
  return getEnvironment('DEV');
}

describe('environments', () => {
  it('exposes the 4 default environments with per-env approval policy', () => {
    assert.deepEqual(Object.keys(ENVIRONMENTS).sort(), ['DEV', 'LOCAL', 'PROD', 'UAT']);
    assert.equal(ENVIRONMENTS.LOCAL.approvalPolicy, 'AUTO');
    assert.equal(ENVIRONMENTS.DEV.approvalPolicy, 'AUTO');
    assert.equal(ENVIRONMENTS.UAT.approvalPolicy, 'AI_REVIEW');
    // PROD policy comes from @ai-factory/approvals' policy check (spec §41 Mode A)
    assert.equal(ENVIRONMENTS.PROD.approvalPolicy, 'HUMAN_APPROVAL');
  });

  it('maps env names to approvals action names', () => {
    assert.equal(approvalActionFor('PROD'), 'deploy.prod');
    assert.equal(approvalActionFor('UAT'), 'deploy.uat');
  });

  it('evaluates the approval policy via @ai-factory/approvals', () => {
    const prod = evaluateApprovalPolicy('PROD');
    assert.equal(prod.level, 'HUMAN_APPROVAL');
    assert.equal(prod.requiresApproval, true);
    assert.match(prod.reason, /deploy\.prod/);

    assert.equal(approvalPolicyFor('UAT'), 'AI_REVIEW');
    assert.equal(approvalPolicyFor('DEV'), 'AUTO');
  });

  it('ApprovalBlockedError is an Error subclass', () => {
    assert.ok(new ApprovalBlockedError('x') instanceof Error);
  });

  it('getEnvironment throws for unknown names', () => {
    assert.throws(() => getEnvironment('STAGING' as never), /Unknown environment/);
  });

  it('PROD never references raw secrets (spec §40)', () => {
    assert.match(ENVIRONMENTS.PROD.secretsRef, /vault ref/i);
  });
});

describe('SnapshotStore + rollback', () => {
  it('takes and restores snapshots', () => {
    const store = new SnapshotStore();
    const snap = store.take('pre-deploy', { version: '1.2.3' }, 'PROD');
    assert.equal(snap.label, 'pre-deploy');
    assert.equal(snap.environment, 'PROD');
    assert.deepEqual(store.get(snap.id), snap);
    const { snapshot } = rollback(store, snap.id);
    assert.deepEqual(snapshot.data, { version: '1.2.3' });
  });

  it('rollback throws for unknown snapshot ids', () => {
    assert.throws(() => rollback(new SnapshotStore(), 'nope'), SnapshotNotFoundError);
  });
});

describe('DeploymentService', () => {
  it('PROD deploy without approval parks at AWAITING_APPROVAL with a clear reason', async () => {
    const store = new SnapshotStore();
    const svc = new DeploymentService();
    let deployed = false;
    const { deployment, pendingApproval } = await svc.deploy({
      pipelineId: 'pipe-1',
      environment: getEnvironment('PROD'),
      store,
      deployFn: async (): Promise<DeployFnResult> => {
        deployed = true;
        return { logs: [] };
      },
    });

    assert.equal(deployment.status, 'AWAITING_APPROVAL');
    assert.equal(deployed, false, 'must not deploy before approval');
    assert.ok(pendingApproval, 'a pending-approval descriptor is returned');
    assert.equal(pendingApproval.action, 'deploy.prod');
    assert.equal(pendingApproval.level, 'HUMAN_APPROVAL');
    assert.equal(pendingApproval.requiresApproval, true);
    assert.match(pendingApproval.reason, /HUMAN_APPROVAL/);
    assert.ok(deployment.snapshotId, 'a snapshot is taken even before approval');
  });

  it('PROD deploy with a pre-granted approval proceeds to SUCCEEDED', async () => {
    const store = new SnapshotStore();
    const svc = new DeploymentService();
    const { deployment, pendingApproval } = await svc.deploy({
      pipelineId: 'pipe-2',
      environment: getEnvironment('PROD'),
      store,
      approvalId: 'approval-123',
    });
    assert.equal(pendingApproval, null);
    assert.equal(deployment.status, 'SUCCEEDED');
    assert.equal(deployment.approvalId, 'approval-123');
    assert.ok(deployment.startedAt && deployment.endedAt);
  });

  it('resume() continues a parked deploy after approval', async () => {
    const store = new SnapshotStore();
    const svc = new DeploymentService();
    const { deployment, pendingApproval } = await svc.deploy({
      pipelineId: 'pipe-3',
      environment: getEnvironment('PROD'),
      store,
    });
    assert.ok(pendingApproval);
    const outcome = await svc.resume(pendingApproval.deploymentId, {
      approvalId: 'approval-456',
    });
    assert.equal(outcome.deployment.status, 'SUCCEEDED');
    assert.equal(outcome.deployment.approvalId, 'approval-456');
    assert.equal(deployment.id, outcome.deployment.id);
  });

  it('resume() throws for deployments that are not awaiting approval', async () => {
    const svc = new DeploymentService();
    await assert.rejects(
      svc.resume('unknown-id', { approvalId: 'a' }),
      /not found/,
    );
    const store = new SnapshotStore();
    const { deployment } = await svc.deploy({
      pipelineId: 'pipe-4',
      environment: devEnv(),
      store,
    });
    assert.equal(deployment.status, 'SUCCEEDED');
    await assert.rejects(
      svc.resume(deployment.id, { approvalId: 'a' }),
      DeploymentNotPendingError,
    );
  });

  it('deploy failure auto-rolls back and restores the snapshot (spec §77)', async () => {
    const store = new SnapshotStore();
    const audits: string[] = [];
    const evidence: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const svc = new DeploymentService({
      audit: (action) => audits.push(action),
      evidence: (type, payload) => evidence.push({ type, payload }),
    });
    const preDeployState = { version: '1.2.3', replicas: 3 };
    const { deployment } = await svc.deploy({
      pipelineId: 'pipe-5',
      environment: devEnv(),
      store,
      preDeployState,
      deployFn: async (): Promise<DeployFnResult> => {
        throw new Error('helm upgrade failed: image pull backoff');
      },
    });

    assert.equal(deployment.status, 'ROLLED_BACK');
    assert.match(deployment.error ?? '', /helm upgrade failed/);
    assert.ok(deployment.snapshotId);
    const restored = store.get(deployment.snapshotId!);
    assert.deepEqual(restored?.data, preDeployState, 'snapshot data intact');
    assert.ok(audits.includes('DEPLOYMENT_ROLLED_BACK'));
    const rollbackEvidence = evidence.find(
      (e) => e.type === 'deployment' && e.payload['status'] === 'ROLLED_BACK',
    );
    assert.equal(rollbackEvidence?.payload['restoredSnapshotId'], deployment.snapshotId);
  });

  it('smoke test failure also triggers auto-rollback', async () => {
    const store = new SnapshotStore();
    const svc = new DeploymentService();
    const { deployment } = await svc.deploy({
      pipelineId: 'pipe-6',
      environment: devEnv(),
      store,
      smokeFn: async (): Promise<DeployFnResult> => {
        throw new Error('/healthz returned 500');
      },
    });
    assert.equal(deployment.status, 'ROLLED_BACK');
    assert.match(deployment.error ?? '', /healthz/);
  });

  it('refuses deploys to environments with no rollback method (spec §77 gate)', async () => {
    const store = new SnapshotStore();
    const svc = new DeploymentService();
    const noRollback: Environment = {
      ...devEnv(),
      name: 'PROD',
      rollbackMethod: '',
    };
    await assert.rejects(
      svc.deploy({ pipelineId: 'pipe-7', environment: noRollback, store }),
      (err: unknown) => {
        assert.ok(err instanceof RollbackCapabilityError);
        assert.match((err as Error).message, /rollback capability/);
        return true;
      },
    );
    // the gate fires before any snapshot is taken
    assert.equal(store.list().length, 0);
  });

  it('emits evidence for snapshots and successful deployments', async () => {
    const store = new SnapshotStore();
    const seen: string[] = [];
    const svc = new DeploymentService({
      evidence: (type) => seen.push(type),
    });
    await svc.deploy({ pipelineId: 'pipe-8', environment: devEnv(), store });
    assert.ok(seen.includes('deploy-snapshot'));
    assert.ok(seen.includes('deployment'));
  });
});
