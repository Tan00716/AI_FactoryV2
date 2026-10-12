/**
 * DeploymentService job registry — Batch 16.
 *
 * A parked job carries the deploy/smoke functions and the evidence /
 * audit callbacks captured at deploy time, so resume() can only find
 * it through the registry the deploying instance wrote to. These tests
 * pin the two registry modes:
 *
 *   - default: one private registry per instance — an instance that
 *     did not deploy cannot resume (DeploymentNotFoundError). This is
 *     the mechanism behind the old server defect, where each HTTP
 *     handler built its own service and /approve could never resume.
 *   - injected shared registry: instances built over the same
 *     DeploymentJobRegistry hand parked jobs to each other, which is
 *     how the server routes (one service per request) make the
 *     deploy → approve flow work.
 *
 * Run: node --test dist/tests/deploy-shared-registry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeploymentNotFoundError,
  DeploymentService,
  SnapshotStore,
  getEnvironment,
  type DeploymentJobRegistry,
} from '../src/index';

describe('DeploymentService job registry (Batch 16)', () => {
  it('instances sharing a registry resume each other\'s parked deployments', async () => {
    const jobs: DeploymentJobRegistry = new Map();
    const store = new SnapshotStore();
    const deployer = new DeploymentService({ jobs });
    const approver = new DeploymentService({ jobs });

    const { deployment, pendingApproval } = await deployer.deploy({
      pipelineId: 'pipe-shared',
      environment: getEnvironment('PROD'),
      store,
    });
    assert.equal(deployment.status, 'AWAITING_APPROVAL');
    assert.ok(pendingApproval);

    const outcome = await approver.resume(deployment.id, { approvalId: 'approval-1' });
    assert.equal(outcome.deployment.status, 'SUCCEEDED');
    assert.equal(outcome.deployment.approvalId, 'approval-1');
    assert.equal(outcome.pendingApproval, null);
    // The deployment record is the same object the deployer returned.
    assert.equal(deployment.status, 'SUCCEEDED');
  });

  it('without a shared registry a second instance cannot see the parked job', async () => {
    const store = new SnapshotStore();
    const deployer = new DeploymentService();
    const stranger = new DeploymentService();

    const { deployment } = await deployer.deploy({
      pipelineId: 'pipe-private',
      environment: getEnvironment('PROD'),
      store,
    });
    assert.equal(deployment.status, 'AWAITING_APPROVAL');

    await assert.rejects(
      () => stranger.resume(deployment.id, { approvalId: 'approval-1' }),
      DeploymentNotFoundError,
    );
    // The deploying instance itself can still resume it.
    const outcome = await deployer.resume(deployment.id, { approvalId: 'approval-1' });
    assert.equal(outcome.deployment.status, 'SUCCEEDED');
  });
});
