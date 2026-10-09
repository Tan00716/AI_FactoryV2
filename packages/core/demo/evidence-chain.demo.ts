/**
 * Demo: "Evidence beats claims" — a task walks TODO → DONE, and a transition
 * is DENIED when required evidence is missing (with the denial naming exactly
 * what is missing), then succeeds once the evidence exists.
 *
 * Run: npm run demo   (from the repo root)
 */
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  TaskStatus,
  WorkflowEngine,
} from '../src/index';

const step = (n: number, msg: string) => console.log(`\n[step ${n}] ${msg}`);
const okMark = (ok: boolean) => (ok ? '✅' : '⛔');

function main(): void {
  const tasks = new TaskManager();
  const evidence = new EvidenceEngine();
  const audit = new AuditLog();
  const agents = new AgentRegistry();
  const engine = new WorkflowEngine({ tasks, evidence, audit });

  // --- Cast ----------------------------------------------------------------
  const pm = agents.register({ name: 'pm-01', jobTitle: 'AI PM', autonomyLevel: 4 });
  const coder = agents.register({
    name: 'coder-01', jobTitle: 'Senior Backend Engineer',
    parentAgentId: pm.id, autonomyLevel: 4,
  });
  const qa = agents.register({
    name: 'qa-01', jobTitle: 'QA Lead',
    parentAgentId: pm.id, autonomyLevel: 3,
  });

  const task = tasks.create({
    projectId: 'demo-project',
    title: 'Fix payment success but order stays Pending',
    goal: 'A successful payment must always reach the correct final order state.',
    priority: 'P1',
    acceptanceCriteria: ['524/524 unit tests pass', 'No regression in login flow'],
  });
  tasks.assignAgent(task.id, pm.id);

  const attach = (
    type: 'plan' | 'code_change' | 'code_review' | 'ci_result' | 'qa_result' | 'security_report' | 'merge' | 'uat_result' | 'approval' | 'deployment' | 'smoke_test',
    payload: Record<string, unknown>,
    by: string,
  ) => {
    const ev = evidence.create({ taskId: task.id, type, title: `${type} evidence`, payload, createdBy: by });
    console.log(`   📎 evidence attached: ${type} (${ev.id.slice(0, 8)}…)`);
    return ev;
  };

  let n = 0;
  const move = (to: TaskStatus, actor: string) => {
    const r = engine.requestTransition(task.id, to, actor);
    console.log(`   ${okMark(r.ok)} ${r.ok ? `${r.from} → ${r.to}` : `DENIED ${r.from} → ${r.to}: ${r.missing.join('; ')}`}`);
    return r;
  };

  step(++n, 'PM picks up the task: TODO → PLANNING');
  move('PLANNING', pm.id);

  step(++n, 'PM plans, attaches the PLAN artifact: PLANNING → IN PROGRESS');
  attach('plan', { title: 'Payment race-condition fix plan v1' }, pm.id);
  move('IN_PROGRESS', pm.id);
  tasks.assignAgent(task.id, coder.id);

  step(++n, 'Coder implements and submits a commit: IN PROGRESS → CODE REVIEW');
  attach('code_change', { sha: '9f3c1a2', files: 11 }, coder.id);
  move('CODE_REVIEW', coder.id);

  step(++n, 'Reviewer approves: CODE REVIEW → PENDING QA → QA');
  attach('code_review', { verdict: 'PASS', reviewer: 'reviewer-01' }, 'reviewer-01');
  move('PENDING_QA', 'reviewer-01');
  move('QA', qa.id);
  tasks.assignAgent(task.id, qa.id);

  step(++n, 'QA finishes — but the security report is NOT attached yet.');
  attach('ci_result', { verdict: 'PASS', build: '#481' }, qa.id);
  attach('qa_result', { verdict: 'PASS', total: 524, passed: 524, failed: 0 }, qa.id);
  console.log('   Attempting QA → PENDING_UAT_MERGE without security evidence…');
  const denied = move('PENDING_UAT_MERGE', qa.id);
  if (denied.ok) throw new Error('demo invariant broken: gate should have denied');
  console.log('   👆 The engine refused and named the missing item. "Tests passed" alone is not enough (§2.4).');

  step(++n, 'Security scan completes and its evidence is attached — retry the gate.');
  attach('security_report', { verdict: 'PASS', criticals: 0 }, 'security-agent');
  move('PENDING_UAT_MERGE', qa.id);

  step(++n, 'Merge to UAT, UAT passes.');
  attach('merge', { pr: 481, branch: 'release/uat' }, 'devops-01');
  move('UAT', 'devops-01');
  attach('uat_result', { verdict: 'PASS', scenarios: '42/42' }, qa.id);
  move('PENDING_PROD', qa.id);

  step(++n, 'Production gate: human approval required (§41 Mode A).');
  attach('approval', { by: 'human', decision: 'APPROVED', risk: 'MEDIUM' }, 'human');
  move('PROD_DEPLOYING', 'human');

  step(++n, 'Deploy + production smoke test → DONE.');
  attach('deployment', { env: 'prod', build: '1.2.3' }, 'devops-01');
  move('PROD_VERIFICATION', 'devops-01');
  attach('smoke_test', { verdict: 'PASS', checks: '18/18' }, 'devops-01');
  move('DONE', 'devops-01');

  const done = tasks.get(task.id);
  console.log(`\n🎉 Task "${done.title}" is ${done.status} (completed at ${done.completedAt})`);

  console.log('\n--- Evidence chain (all gate evidence is now SEALED/immutable) ---');
  for (const ev of evidence.listByTask(task.id)) {
    console.log(`   [${ev.status}] ${ev.type} — ${ev.title}`);
  }

  console.log('\n--- Audit trail (append-only) ---');
  for (const r of audit.list()) {
    console.log(`   ${r.ts}  ${r.actor}  ${r.action}  ${r.entityType}:${r.entityId.slice(0, 8)}…`);
  }
}

main();
