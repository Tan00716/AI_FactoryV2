/**
 * Demo: §12.2 delegation chain PM → Lead → Coder.
 *
 * 1. Root delegation from the Human dispatch: task budget 1000 reserved.
 * 2. PM delegates to Lead (subset scope, 600 of the 1000 reserved).
 * 3. Lead delegates to Coder (subset scope, 400 of the 600 reserved).
 * 4. Prints remaining budgets at each level.
 * 5. Shows a rejected over-reservation and a rejected scope superset.
 * 6. Shows handoff moving execution ownership while supervision stays.
 */
import { DelegationManager, DelegationError, isSubset } from '../src/index';

const mgr = new DelegationManager({ maxDepth: 5 });

const SCOPE_ROOT = ['project:crm', 'path:/workspace/crm', 'tool:shell.exec', 'tool:tests.run'];
const SCOPE_LEAD = ['project:crm', 'path:/workspace/crm', 'tool:shell.exec'];
const SCOPE_CODER = ['project:crm', 'path:/workspace/crm'];

const root = mgr.activate(
  mgr.createRoot({
    delegation_id: 'demo-dlg-root',
    delegator: 'human-dispatch',
    delegatee: 'pm-01',
    root_authorization_id: 'auth-demo-001',
    task_id: 'task-demo-bug-42',
    requirement_version: 'REQ-DEMO@1',
    scope: SCOPE_ROOT,
    AC_refs: ['AC-1: bug fixed', 'AC-2: tests green'],
    allowed_outputs: ['diff', 'test-report'],
    evidence_requirements: ['unit-tests', 'diff'],
    budget_reservation: 1000,
    reporting_targets: ['human-dispatch'],
    review_policy: 'independent-qa',
  }).delegation_id,
);

const lead = mgr.activate(
  mgr.create({
    delegation_id: 'demo-dlg-lead',
    parent_delegation_id: root.delegation_id,
    delegator: 'pm-01',
    delegatee: 'lead-01',
    root_authorization_id: 'auth-demo-001',
    task_id: 'task-demo-bug-42',
    requirement_version: 'REQ-DEMO@1',
    scope: SCOPE_LEAD,
    AC_refs: ['AC-1: bug fixed'],
    budget_reservation: 600,
    reporting_targets: ['pm-01'],
    review_policy: 'manager-review',
  }).delegation_id,
);

const coder = mgr.activate(
  mgr.create({
    delegation_id: 'demo-dlg-coder',
    parent_delegation_id: lead.delegation_id,
    delegator: 'lead-01',
    delegatee: 'coder-01',
    root_authorization_id: 'auth-demo-001',
    task_id: 'task-demo-bug-42',
    requirement_version: 'REQ-DEMO@1',
    scope: SCOPE_CODER,
    budget_reservation: 400,
    reporting_targets: ['lead-01'],
    review_policy: 'manager-review',
  }).delegation_id,
);

console.log('=== DELEGATION CHAIN (PM → Lead → Coder) ===');
for (const d of [root, lead, coder]) {
  const cur = mgr.get(d.delegation_id);
  console.log(
    `${cur.delegation_id}: owner=${cur.owner} oversight_by=${cur.oversight_by} ` +
      `reserved=${cur.budget_reservation} remaining-for-children=${mgr.remainingBudget(cur.delegation_id)}`,
  );
}
console.log(`depth of coder delegation: ${mgr.depthOf(coder.delegation_id)} (limit 5)`);

console.log('\n=== REJECTED: over-reservation (400 > lead remaining 200) ===');
try {
  mgr.create({
    parent_delegation_id: lead.delegation_id,
    delegator: 'lead-01',
    delegatee: 'coder-02',
    root_authorization_id: 'auth-demo-001',
    task_id: 'task-demo-bug-42',
    requirement_version: 'REQ-DEMO@1',
    scope: SCOPE_CODER,
    budget_reservation: 400,
  });
  console.log('UNEXPECTED: accepted');
} catch (e) {
  console.log(`${(e as DelegationError).code}: ${(e as Error).message}`);
}

console.log('\n=== REJECTED: scope superset (adds path:/etc) ===');
try {
  mgr.create({
    parent_delegation_id: lead.delegation_id,
    delegator: 'lead-01',
    delegatee: 'coder-02',
    root_authorization_id: 'auth-demo-001',
    task_id: 'task-demo-bug-42',
    requirement_version: 'REQ-DEMO@1',
    scope: [...SCOPE_CODER, 'path:/etc'],
    budget_reservation: 50,
  });
  console.log('UNEXPECTED: accepted');
} catch (e) {
  console.log(`${(e as DelegationError).code}: ${(e as Error).message}`);
}

console.log('\n=== HANDOFF: lead-01 hands execution to coder-01 ===');
console.log(`before: owner=${mgr.get(coder.delegation_id).owner}, oversight_by=${mgr.get(coder.delegation_id).oversight_by}`);
const handed = mgr.handoff(coder.delegation_id, 'lead-01');
console.log(`after:  owner=${handed.owner}, oversight_by=${handed.oversight_by} (supervision stays with delegator)`);
console.log(`scope subset helper: ${isSubset(SCOPE_CODER, SCOPE_LEAD)}`);
