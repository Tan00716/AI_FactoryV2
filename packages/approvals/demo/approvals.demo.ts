/**
 * Demo: v2 approval hardening (SPEC §23.3, DEF-001 fixes).
 *
 * Shows: (1) a normal deploy.prod approval flow, (2) request() refusing a
 * BLOCKED action (secret.write) — DEF-001 fix 1, (3) decide() rejecting a
 * rogue-agent self-approval — DEF-001 fix 2, (4) invalidation when the bound
 * context changes after approval.
 *
 * Run: node packages/approvals/dist/demo/approvals.demo.js
 */
import {
  ApprovalBlockedError,
  ApprovalDeciderNotAuthorizedError,
  ApprovalManager,
  InMemoryApprovalStore,
} from '../src/index';

const manager = new ApprovalManager(new InMemoryApprovalStore(), {
  audit: (action, entityId, details) =>
    console.log(`  [audit] ${action} ${entityId.slice(0, 8)}…`, JSON.stringify(details)),
  policyVersion: 'v2-demo',
});

const BINDING = {
  candidate_digest: 'sha256:release-1.2.3',
  evidence_manifest_hash: 'sha256:manifest-77',
  policy_version: 'v2-demo',
  environment: 'prod',
  risk_level: 'HIGH' as const,
  reversibility_ref: '',
};

console.log('== 1. normal deploy.prod flow ==');
const a = manager.request({
  action: 'deploy.prod',
  requester: 'release-bot',
  task_id: 'task-42',
  ...BINDING,
});
console.log('  requested →', a.status, '| required_approvers:', a.required_approvers);
const decided = manager.decide(a.approval_id, {
  approved: true,
  decided_by: 'human',
  decision_reason: 'canary green, rollback ready',
});
console.log('  decided →', decided.status, 'by', decided.decided_by);

console.log('== 2. DEF-001 fix 1: BLOCKED action refused at request() ==');
try {
  manager.request({ action: 'secret.write', requester: 'rogue-agent' });
  console.log('  !! NOT REFUSED — bug');
} catch (e) {
  console.log('  refused:', (e as Error).name, '-', e instanceof ApprovalBlockedError);
}

console.log('== 3. DEF-001 fix 2: rogue-agent cannot self-approve ==');
const b = manager.request({ action: 'deploy.prod', requester: 'rogue-agent' });
try {
  manager.decide(b.approval_id, { approved: true, decided_by: 'rogue-agent' });
  console.log('  !! NOT REJECTED — bug');
} catch (e) {
  console.log('  rejected:', (e as Error).name, '-', e instanceof ApprovalDeciderNotAuthorizedError);
  console.log('  ticket still:', manager.get(b.approval_id).status);
}

console.log('== 4. bound-context change invalidates the approval ==');
const r = manager.invalidate(a.approval_id, {
  ...BINDING,
  candidate_digest: 'sha256:release-1.2.4', // new code, old approval must not apply
});
console.log('  invalidated:', r.invalidated, '| changed:', r.changed);
console.log('  status now:', manager.get(a.approval_id).status);
try {
  manager.approvalEvidencePayload(manager.get(a.approval_id));
  console.log('  !! payload built from INVALIDATED approval — bug');
} catch {
  console.log('  evidence payload correctly refused for INVALIDATED approval');
}

console.log('\ndone.');
