/**
 * Demo: in FULL autonomy mode a production deploy is auto-approved by
 * decide() — but the independent §41 checklist still blocks it when the
 * security gate has no concrete evidence (only an AI assertion).
 *
 * Run after building the package:
 *   npx tsc -p packages/autonomy/tsconfig.json
 *   node packages/autonomy/dist/demo/full-mode-blocked.demo.js
 */
import {
  AutonomyMode,
  ProjectAutonomyStore,
  decide,
  needsHuman,
  requireApproval,
  verifyProdReadiness,
} from '../src/index';

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function main(): void {
  // 1. Project runs in FULL autonomy mode (§80).
  const store = new ProjectAutonomyStore();
  const projectId = 'demo-shop';
  store.set(projectId, 'full', 'tan');
  const mode: AutonomyMode = store.get(projectId).mode;
  console.log(`project '${projectId}' autonomy mode: ${mode} / 全自动模式`);

  // 2. The deploy action itself is auto-approved in full mode …
  section('1. decide(deploy-prod, full)');
  const d = decide({ kind: 'deploy-prod', summary: 'Deploy v1.4.2 to production' }, mode);
  console.log(`outcome=${d.outcome} step=${d.step}`);
  console.log(`reason: ${d.reason}`);
  console.log(`requiresProdVerification=${d.requiresProdVerification}`);

  const approval = requireApproval('deploy-prod', mode);
  console.log(`approval required=${approval.required} type=${approval.approvalType}`);

  // 3. … but evidence is incomplete: the AI *asserts* security passed,
  //    with no concrete evidence artifact. verifyProdReadiness must NOT
  //    trust the assertion alone (§41 + §80).
  section('2. verifyProdReadiness (security = AI assertion only)');
  const verdict = verifyProdReadiness({
    build: { passed: true, evidenceId: 'ev-build-8841' },
    tests: { passed: true, evidenceId: 'ev-tests-8841' },
    security: { passed: true, aiAssertedOnly: true, note: 'AI claims scan passed' },
    rollback: { passed: true, evidenceId: 'ev-rollback-8841' },
    healthCheck: { passed: true, evidenceId: 'ev-health-8841' },
    artifact: { passed: true, evidenceId: 'ev-artifact-8841' },
    environment: { passed: true, evidenceId: 'ev-env-8841' },
    commitSha: 'deadbeef',
    requestedBy: 'deploy-agent-7',
  });
  console.log(verdict.message);
  console.log(`passed: [${verdict.passed.join(', ')}]`);
  console.log(`missing: [${verdict.missing.join(', ')}]`);

  // 4. Result: deploy blocked → escalate to a human (§81 security issue).
  section('3. outcome');
  if (!verdict.ready) {
    console.log('DEPLOY BLOCKED / 部署被拦下 — even in full mode, the independent checklist vetoes.');
    const esc = needsHuman('security-issue', {
      detail: `deploy-prod v1.4.2 blocked: security gate has only an AI assertion, no evidence (verdict ${verdict.id.slice(0, 8)})`,
      context: { projectId, commitSha: 'deadbeef' },
    });
    console.log(`escalated → human [${esc.severity}] ${esc.reason} / ${esc.reasonZh}`);
    console.log(`record: ${esc.id}`);
  } else {
    console.log('PROCEED / 放行');
  }
}

main();
