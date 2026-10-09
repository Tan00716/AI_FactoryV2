/**
 * Seed data: demo project "MyApp" with an AI organization (§14) and a few
 * tasks spread across the board (§85). Idempotent — skips when already seeded.
 */
import { randomUUID } from 'crypto';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
  nowIso,
} from '@ai-factory/core';
import { FactoryDatabase } from './db';

export function seedIfEmpty(fdb: FactoryDatabase): void {
  const count = (fdb.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  if (count > 0) return;

  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const agents = new AgentRegistry(fdb.agents);
  const engine = new WorkflowEngine({ tasks, evidence, audit });

  const project = fdb.createProject({
    id: 'proj-myapp',
    name: 'MyApp',
    description: 'Demo project for the AI Engineering Factory prototype',
    path: 'C:\\AIProjects\\MyApp',
  });

  // --- AI organization (§14) ------------------------------------------------
  const pm = agents.register({
    name: 'ai-pm', displayName: 'AI PM', jobTitle: 'AI PM',
    department: 'Management', mission: 'Turn requirements into verified results.',
    autonomyLevel: 4, model: 'reasoning',
  });
  const techLead = agents.register({
    name: 'tech-lead', displayName: 'Tech Lead', jobTitle: 'Tech Lead',
    parentAgentId: pm.id, mission: 'Own technical delivery.',
    autonomyLevel: 4, model: 'codex',
  });
  const coder1 = agents.register({
    name: 'coder-01', displayName: 'Coder #01', jobTitle: 'Senior Backend Engineer',
    parentAgentId: techLead.id, autonomyLevel: 4, model: 'codex',
    skills: ['Clean Code', 'Debugging', 'API Development'],
  });
  const coder2 = agents.register({
    name: 'coder-02', displayName: 'Coder #02', jobTitle: 'Senior Frontend Engineer',
    parentAgentId: techLead.id, autonomyLevel: 4, model: 'codex',
  });
  const qaLead = agents.register({
    name: 'qa-lead', displayName: 'QA Lead', jobTitle: 'QA Lead',
    parentAgentId: techLead.id, autonomyLevel: 3,
  });
  const designLead = agents.register({
    name: 'design-lead', displayName: 'Design Lead', jobTitle: 'Design Lead',
    parentAgentId: pm.id, autonomyLevel: 3,
  });
  agents.setStatus(pm.id, 'WORKING');

  const mkTask = (
    title: string,
    goal: string,
    priority: 'P0' | 'P1' | 'P2' | 'P3',
    agentId?: string,
  ) => {
    const t = tasks.create({
      projectId: project.id, title, goal, priority,
      creator: 'human', workspace: 'C:\\AIProjects\\MyApp',
    });
    if (agentId) tasks.assignAgent(t.id, agentId);
    return t;
  };
  const attach = (
    taskId: string, type: 'plan' | 'code_change' | 'code_review' | 'ci_result' | 'qa_result' | 'security_report',
    payload: Record<string, unknown>, by: string,
  ) =>
    evidence.create({ taskId, type, title: `${type}`, payload, createdBy: by });

  // Task 1: walks partway — TODO → IN_PROGRESS (has plan evidence).
  const t1 = mkTask(
    'Fix payment success but order stays Pending',
    'Successful payment must always reach the correct final order state.',
    'P1', pm.id,
  );
  engine.requestTransition(t1.id, 'PLANNING', pm.id);
  attach(t1.id, 'plan', { title: 'Fix plan v1' }, pm.id);
  engine.requestTransition(t1.id, 'IN_PROGRESS', pm.id);
  tasks.assignAgent(t1.id, coder1.id);

  // Task 2: waiting in CODE_REVIEW (has code change, no review verdict yet).
  const t2 = mkTask('Add idempotency key to checkout API', 'Prevent duplicate charges on retry.', 'P2', coder2.id);
  engine.requestTransition(t2.id, 'PLANNING', pm.id);
  attach(t2.id, 'plan', { title: 'Idempotency plan' }, pm.id);
  engine.requestTransition(t2.id, 'IN_PROGRESS', pm.id);
  attach(t2.id, 'code_change', { sha: 'a1b2c3d' }, coder2.id);
  engine.requestTransition(t2.id, 'CODE_REVIEW', coder2.id);

  // Task 3: in QA with full evidence except security → stays QA (gate would deny).
  const t3 = mkTask('Refactor session handling', 'Eliminate stale session race.', 'P2', coder1.id);
  engine.requestTransition(t3.id, 'PLANNING', pm.id);
  attach(t3.id, 'plan', { title: 'Session plan' }, pm.id);
  engine.requestTransition(t3.id, 'IN_PROGRESS', pm.id);
  attach(t3.id, 'code_change', { sha: 'd4e5f6a' }, coder1.id);
  engine.requestTransition(t3.id, 'CODE_REVIEW', coder1.id);
  attach(t3.id, 'code_review', { verdict: 'PASS' }, 'reviewer-01');
  engine.requestTransition(t3.id, 'PENDING_QA', 'reviewer-01');
  engine.requestTransition(t3.id, 'QA', qaLead.id);
  attach(t3.id, 'ci_result', { verdict: 'PASS' }, qaLead.id);
  attach(t3.id, 'qa_result', { verdict: 'PASS', total: 128, passed: 128 }, qaLead.id);
  // Deliberately no security_report: the QA → PENDING_UAT_MERGE gate will deny.

  // Task 4: fresh TODO with subtasks + dependency demo (§60).
  const t4 = mkTask('Dark mode for settings page', 'Ship user-toggleable dark mode.', 'P3');
  const t4a = tasks.createSubtask(t4.id, { title: 'Design tokens for dark palette' });
  const t4b = tasks.createSubtask(t4.id, { title: 'Implement theme switcher' });
  tasks.addDependency(t4b.id, 'depends_on', t4a.id);

  audit.record('system', 'PROJECT_SEEDED', 'project', project.id, {
    agents: 6, tasks: 4, note: 'demo seed',
  });

  console.log(`[seed] project ${project.id}: 6 agents, 6 tasks (incl. subtasks)`);
}

export { randomUUID, nowIso };
