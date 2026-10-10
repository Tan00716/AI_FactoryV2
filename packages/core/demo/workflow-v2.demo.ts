/**
 * Workflow v2 demo — SPEC_V2 §18 (three-state separation) + §19 + §20.1.
 *
 *  1. Illegal jump TODO→DONE → denied with machine reason code POLICY_DENIED.
 *  2. Stale concurrent request → VERSION_CONFLICT.
 *  3. Missing evidence → MISSING_EVIDENCE naming the gap.
 *  4. Legal walk TODO → … → OUTCOME_VERIFICATION with evidence at each gate.
 *  5. finalize(): completion predicates checked, then DONE + final_seal=1 in
 *     one transaction (no "100% requires Done / Done requires 100%" loop).
 *  6. Rollback: RELEASED history kept, current state ROLLED_BACK.
 *  7. Post-DONE regression: COMPLETION_INVALIDATED appended, history intact.
 *
 * Run after building the package:
 *   npx tsc -p packages/core/tsconfig.json
 *   node packages/core/dist/demo/workflow-v2.demo.js
 */
import {
  AuditLog,
  CompletionSnapshot,
  Evidence,
  GateContext,
  WorkflowEngineV2,
  WorkflowStage,
  nowIso,
} from '../src/index';

let n = 0;
const eid = (p: string) => `ev-${p}-${++n}`;

function ev(taskId: string, type: Evidence['type'], verdict?: string): Evidence {
  return {
    id: eid(type), taskId, type, title: `${type} evidence`,
    payload: verdict ? { verdict } : {},
    status: 'DRAFT', createdBy: 'demo',
    createdAt: nowIso(), sealedAt: null,
  };
}

function ctx(taskId: string, taskVersion: number, evidence: Evidence[] = []): GateContext {
  return {
    taskId, taskVersion, actor: 'agent-demo',
    authorization: { status: 'AUTHORIZED', expiresAt: null },
    requirementVersion: 'REQ-001@1',
    candidateDigest: 'sha256:demo',
    implementerId: 'coder-1',
    evidence,
    evidenceReqVersions: Object.fromEntries(evidence.map((e) => [e.id, 'REQ-001@1'])),
    staleEvidenceIds: [],
    budgetOk: true, quotaOk: true, confinementOk: true, dependenciesReady: true,
  };
}

const okSnapshot: CompletionSnapshot = {
  applicableAcs: [{ id: 'AC-001', verified: true }, { id: 'AC-002', verified: true }],
  gatesValid: true, milestonesValid: true, pendingBlocks: [],
  authorizationsComplete: true, releaseApplicable: true, releaseNaAuthorized: false,
};

function main(): void {
  const engine = new WorkflowEngineV2({ audit: new AuditLog() });
  engine.register('demo-task', { requirementRef: 'REQ-001@1' });
  console.log('registered demo-task @ REQ-001@1, stage=TODO condition=ACTIVE');

  // 1. Illegal jump → POLICY_DENIED
  const illegal = engine.requestTransitionV2('demo-task', 'DONE', 'agent-demo', ctx('demo-task', 1));
  console.log(`\n[1] TODO→DONE illegal jump: ok=${illegal.ok} reason=${(illegal as { reasonCode?: string }).reasonCode}`);
  console.log(`    missing: ${(illegal as { missing?: string[] }).missing?.[0]}`);

  // 2. Stale concurrent request → VERSION_CONFLICT
  const stale = engine.requestTransitionV2('demo-task', 'PLANNING', 'agent-demo',
    { ...ctx('demo-task', 1), expectedTaskVersion: 99 });
  console.log(`\n[2] stale version request: ok=${stale.ok} reason=${(stale as { reasonCode?: string }).reasonCode}`);

  // 3. Missing evidence → MISSING_EVIDENCE
  const noEv = engine.requestTransitionV2('demo-task', 'PLANNING', 'agent-demo', ctx('demo-task', 1));
  console.log(`\n[3] START_TASK ok=${noEv.ok} (no gates on this edge)`);

  // PLANNING → IN_PROGRESS without plan evidence
  const denied = engine.requestTransitionV2('demo-task', 'IN_PROGRESS', 'agent-demo',
    ctx('demo-task', engine.get('demo-task').taskVersion));
  console.log(`[3b] PLANNING→IN_PROGRESS without evidence: ok=${denied.ok} reason=${(denied as { reasonCode?: string }).reasonCode}`);
  console.log(`     missing: ${(denied as { missing?: string[] }).missing?.[0]}`);

  // 4. Legal walk with evidence
  console.log('\n[4] legal walk with evidence:');
  const steps: Array<{ to: WorkflowStage; evidence: Evidence[]; reviewer?: string }> = [
    { to: 'IN_PROGRESS', evidence: [ev('demo-task', 'plan')] },
    { to: 'CODE_REVIEW', evidence: [ev('demo-task', 'code_change')] },
    { to: 'PENDING_QA', evidence: [ev('demo-task', 'code_review', 'PASS')], reviewer: 'reviewer-1' },
    { to: 'QA', evidence: [] },
    {
      to: 'PENDING_UAT_MERGE',
      evidence: [
        ev('demo-task', 'code_review', 'PASS'), ev('demo-task', 'ci_result', 'PASS'),
        ev('demo-task', 'qa_result', 'PASS'), ev('demo-task', 'security_report', 'PASS'),
      ],
    },
    { to: 'UAT', evidence: [ev('demo-task', 'merge')] },
    { to: 'PENDING_PROD', evidence: [ev('demo-task', 'uat_result', 'PASS')] },
    { to: 'PROD_DEPLOYING', evidence: [ev('demo-task', 'approval', 'APPROVED')] },
    { to: 'PROD_VERIFICATION', evidence: [ev('demo-task', 'deployment')] },
    { to: 'OUTCOME_VERIFICATION', evidence: [ev('demo-task', 'smoke_test', 'PASS')] },
  ];
  for (const s of steps) {
    const v = engine.get('demo-task').taskVersion;
    const r = engine.requestTransitionV2('demo-task', s.to, s.reviewer ?? 'agent-demo',
      ctx('demo-task', v, s.evidence));
    console.log(`    → ${s.to}: ok=${r.ok}${r.ok ? '' : ` reason=${(r as { reasonCode?: string }).reasonCode}`}`);
    if (!r.ok) throw new Error(`demo walk failed at ${s.to}`);
  }
  engine.markMilestone('demo-task', 'IMPLEMENTED', 'agent-demo');
  engine.markMilestone('demo-task', 'VERIFIED', 'reviewer-1');
  engine.recordRelease('demo-task', 'release-bot', 'v1.2.0');
  engine.markMilestone('demo-task', 'OUTCOME_VERIFIED', 'agent-demo');

  // 5. finalize(): predicates + DONE + final_seal=1, one transaction
  const fin = engine.finalize('demo-task', 'agent-demo', okSnapshot);
  console.log(`\n[5] finalize: ok=${fin.ok}`);
  const st = engine.get('demo-task');
  console.log(`    stage=${st.stage} finalSeal=${st.finalSeal} taskVersion=${st.taskVersion}`);

  // 6. Rollback keeps RELEASED history, current state ROLLED_BACK
  engine.recordRollback('demo-task', 'release-bot', 'smoke regression in prod');
  const rb = engine.get('demo-task');
  console.log(`\n[6] rollback: releaseState=${rb.releaseState} outcomeGateValid=${rb.outcomeGateValid}`);
  console.log(`    releaseHistory=${rb.releaseHistory.map((h) => h.state).join(' → ')}`);

  // 7. Post-DONE regression → COMPLETION_INVALIDATED appended, history intact
  engine.invalidateCompletion('demo-task', 'human-1', 'regression found in prod');
  const inv = engine.get('demo-task');
  console.log(`\n[7] invalidate: stage=${inv.stage} finalSeal=${inv.finalSeal} condition=${inv.condition.condition}`);
  console.log(`    completionHistory=${inv.completionHistory.map((h) => h.kind).join(' → ')}`);
  console.log(`    DONE milestone history kept: ${inv.milestoneHistory.some((h) => h.milestone === 'DONE')}`);

  console.log('\ndemo complete: illegal jumps denied with reason codes; DONE sealed atomically.');
}

main();
