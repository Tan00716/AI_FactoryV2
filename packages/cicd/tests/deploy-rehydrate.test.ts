/**
 * Deployment job rehydration — SPEC v2 §41/§77 (Batch 19-1).
 *
 * A parked job carries in-memory closures, so a restart can never
 * resume the original job. These tests pin the reconstructable-spec
 * contract instead:
 *  - specOf() captures everything needed to rebuild the job, and
 *    nothing that cannot cross a process boundary (no functions —
 *    JSON-serializable, which is what the server persists);
 *  - a fresh DeploymentService over a fresh registry rehydrates the
 *    spec, and resume() on the rebuilt job truly completes the
 *    deployment (SUCCEEDED, approval recorded, rehydrated audit
 *    detail present);
 *  - rehydrate() re-validates the §77 rollback capability against
 *    the spec (not the current ENVIRONMENTS entry): a spec whose
 *    rollback method is gone refuses with
 *    DeploymentUnrecoverableError instead of running unprotected;
 *  - corrupt or non-parked specs refuse loudly, never with an
 *    invented job;
 *  - the rebuilt job restores its §77 snapshot into its own
 *    SnapshotStore, so the failure→rollback path still has a
 *    snapshot to restore.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeploymentNotPendingError,
  DeploymentService,
  DeploymentUnrecoverableError,
  SnapshotStore,
  getEnvironment,
  type DeploymentJobRegistry,
  type DeploymentRehydrationSpec,
} from '../src/index';

function prodEnv() {
  return getEnvironment('PROD');
}

describe('deployment rehydration (Batch 19)', () => {
  it('specOf is JSON-serializable and rebuilds a resumable job', async () => {
    const jobs: DeploymentJobRegistry = new Map();
    const deployer = new DeploymentService({ jobs });
    const { deployment, pendingApproval } = await deployer.deploy({
      pipelineId: 'pipe-rehydrate',
      environment: prodEnv(),
      store: new SnapshotStore(),
      taskId: 'task-1',
      actor: 'deploy-bot',
      secretRefs: ['DB_PASSWORD'],
    });
    assert.equal(deployment.status, 'AWAITING_APPROVAL');
    assert.ok(pendingApproval);

    const spec = deployer.specOf(deployment.id);
    // Serializable — this is what actually crosses the restart.
    const revived = JSON.parse(JSON.stringify(spec)) as DeploymentRehydrationSpec;
    assert.deepEqual(revived.secretRefs, ['DB_PASSWORD']);

    // A brand-new process: fresh service, fresh registry, no memory
    // of the original job.
    const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const jobs2: DeploymentJobRegistry = new Map();
    const resumer = new DeploymentService({
      jobs: jobs2,
      audit: (action, details) => audits.push({ action, detail: details }),
    });
    const job = resumer.rehydrate(revived);
    assert.equal(job.rehydrated, true);
    assert.ok(
      audits.some((a) => a.action === 'DEPLOYMENT_REHYDRATED' && a.detail['rehydrated'] === true),
      'rebuild is on the audit trail',
    );

    const outcome = await resumer.resume(deployment.id, { approvalId: 'approval-9' });
    assert.equal(outcome.deployment.status, 'SUCCEEDED');
    assert.equal(outcome.deployment.approvalId, 'approval-9');
    assert.ok(
      audits.some(
        (a) => a.action === 'DEPLOY_RESUMED' && a.detail['rehydrated'] === true,
      ),
      'resume of a rebuilt job says it was rebuilt',
    );
  });

  it('a rebuilt job whose deployFn fails still restores its §77 snapshot', async () => {
    const jobs: DeploymentJobRegistry = new Map();
    const deployer = new DeploymentService({ jobs });
    const { deployment } = await deployer.deploy({
      pipelineId: 'pipe-rehydrate-rollback',
      environment: prodEnv(),
      store: new SnapshotStore(),
    });
    const spec = JSON.parse(JSON.stringify(deployer.specOf(deployment.id)));
    const jobs2: DeploymentJobRegistry = new Map();
    const resumer = new DeploymentService({ jobs: jobs2 });
    const job = resumer.rehydrate(spec, {
      deployFn: async () => {
        throw new Error('boom');
      },
    });
    assert.ok(job.store.get(job.snapshot.id), 'snapshot restored into the rebuilt job');
    const outcome = await resumer.resume(deployment.id, { approvalId: 'approval-9' });
    assert.equal(outcome.deployment.status, 'ROLLED_BACK');
  });

  it('rollback capability is re-validated from the spec, not the live config', async () => {
    const jobs: DeploymentJobRegistry = new Map();
    const deployer = new DeploymentService({ jobs });
    const { deployment } = await deployer.deploy({
      pipelineId: 'pipe-no-rollback',
      environment: prodEnv(),
      store: new SnapshotStore(),
    });
    const spec = JSON.parse(JSON.stringify(deployer.specOf(deployment.id)));
    spec.rollbackMethod = '';
    const resumer = new DeploymentService({ jobs: new Map() });
    assert.throws(() => resumer.rehydrate(spec), DeploymentUnrecoverableError);
  });

  it('corrupt specs and non-parked specs refuse loudly', async () => {
    const resumer = new DeploymentService({ jobs: new Map() });
    assert.throws(
      () => resumer.rehydrate(null as never),
      DeploymentUnrecoverableError,
    );
    assert.throws(
      () => resumer.rehydrate({} as never),
      DeploymentUnrecoverableError,
    );

    // A spec whose deployment already completed is not rehydratable —
    // resume() on it must say "not pending", not silently re-run.
    const jobs: DeploymentJobRegistry = new Map();
    const deployer = new DeploymentService({ jobs });
    const { deployment } = await deployer.deploy({
      pipelineId: 'pipe-done',
      environment: getEnvironment('DEV'),
      store: new SnapshotStore(),
    });
    assert.equal(deployment.status, 'SUCCEEDED');
    const spec = JSON.parse(JSON.stringify(deployer.specOf(deployment.id)));
    const resumer2 = new DeploymentService({ jobs: new Map() });
    assert.throws(() => resumer2.rehydrate(spec), DeploymentUnrecoverableError);
  });

  it('specOf on an unknown deployment throws DeploymentNotFoundError', () => {
    const svc = new DeploymentService();
    assert.throws(() => svc.specOf('nope'), /not found/i);
    void DeploymentNotPendingError;
  });
});
