/**
 * CI/CD engine demo — spec §39–§41, §77.
 *
 *  Scenario 1: full pipeline (build → smoke) targeting UAT succeeds, then a
 *    PROD deploy parks at AWAITING_APPROVAL (HUMAN_APPROVAL per
 *    @ai-factory/approvals), a human approves, and resume() deploys with a
 *    green smoke test. Evidence + audit callbacks are printed as they fire.
 *  Scenario 2: a deploy whose smoke test fails → auto-rollback to the
 *    pre-deploy snapshot (spec §77).
 *
 * Run after building the package:
 *   npm run build -w @ai-factory/cicd
 *   node packages/cicd/dist/demo/cicd.demo.js
 */
import {
  DeploymentService,
  ENVIRONMENTS,
  PIPELINE_STAGE_ORDER,
  PipelineRunner,
  SnapshotStore,
  getEnvironment,
  type Environment,
} from '../src/index';

const section = (title: string): void => console.log(`\n=== ${title} ===`);

async function scenario1(): Promise<void> {
  section('Scenario 1 — pipeline to UAT, then approved PROD deploy');

  const runner = new PipelineRunner({
    onStageStart: (s) => console.log(`  ▶ stage started: ${s.name}`),
    onStageEnd: (s) => console.log(`  ✔ stage ${s.status.toLowerCase()}: ${s.name}`),
    evidence: (type, payload) =>
      console.log(`    🧾 evidence[${type}]: ${(payload['artifact'] as { name?: string } | undefined)?.name ?? payload['status'] ?? ''}`),
    audit: (action) => console.log(`    📝 audit: ${action}`),
  });

  const pipeline = runner.createPipeline('UAT', 'deadbee');
  const done = await runner.run(pipeline);
  console.log(`\npipeline ${done.id.slice(0, 8)} → ${done.status}`);
  console.log(`stages: ${PIPELINE_STAGE_ORDER.join(' → ')}`);

  // PROD deploy: the policy check says HUMAN_APPROVAL (spec §41 Mode A).
  const store = new SnapshotStore();
  const svc = new DeploymentService({
    audit: (action, detail) => console.log(`    📝 audit: ${action} (${JSON.stringify(detail.status ?? detail['level'] ?? '')})`),
    evidence: (type) => console.log(`    🧾 evidence: ${type}`),
  });
  const prod: Environment = getEnvironment('PROD');
  console.log(`\ndeploying to PROD (policy: ${ENVIRONMENTS.PROD.approvalPolicy})…`);
  const { deployment, pendingApproval } = await svc.deploy({
    pipelineId: done.id,
    environment: prod,
    store,
    preDeployState: { version: '1.2.3' },
  });
  console.log(`deployment status: ${deployment.status}`);
  if (pendingApproval) {
    console.log(`⏸  blocked on approval: [${pendingApproval.level}] ${pendingApproval.reason}`);
    console.log(`   → server would call ApprovalManager.request({ action: '${pendingApproval.action}' })`);
    // The human approves in the UI; the server resumes with the approval id.
    console.log('   → human APPROVED the request');
    const resumed = await svc.resume(pendingApproval.deploymentId, {
      approvalId: 'approval-demo-1',
    });
    console.log(`deployment after resume → ${resumed.deployment.status} (approval: ${resumed.deployment.approvalId})`);
  }
}

async function scenario2(): Promise<void> {
  section('Scenario 2 — failed deploy → automatic rollback (spec §77)');

  const store = new SnapshotStore();
  const svc = new DeploymentService({
    audit: (action, detail) =>
      console.log(`  📝 audit: ${action} ${detail['message'] ? `— ${detail['message']}` : ''}`),
    evidence: (type, payload) =>
      console.log(`  🧾 evidence: ${type} ${payload['restoredSnapshotId'] ? `(snapshot ${String(payload['restoredSnapshotId']).slice(0, 8)} restored)` : ''}`),
  });

  const { deployment } = await svc.deploy({
    pipelineId: 'pipe-demo-2',
    environment: getEnvironment('UAT'),
    store,
    // UAT needs AI_REVIEW per @ai-factory/approvals — treat it as pre-granted
    // for this scenario so the deploy proceeds and then fails.
    approvalId: 'ai-review-demo-2',
    preDeployState: { version: '1.2.3' },
    smokeFn: async () => {
      throw new Error('/healthz returned 500 — deployment unhealthy');
    },
  });

  console.log(`\ndeployment → ${deployment.status}`);
  const restored = deployment.snapshotId ? store.get(deployment.snapshotId) : undefined;
  console.log(`snapshot ${deployment.snapshotId?.slice(0, 8)} restored to pre-deploy state: ${JSON.stringify(restored?.data)}`);
}

async function main(): Promise<void> {
  console.log('CI/CD engine demo — spec §39 (pipeline), §40 (envs), §41 (policy), §77 (snapshot/rollback)');
  await scenario1();
  await scenario2();
  console.log('\n✅ demo complete: approved PROD deploy succeeded; failed UAT deploy rolled back');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
