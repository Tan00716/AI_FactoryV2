/**
 * Demo: full orchestrator pipeline for the §95 example task —
 * "payment success but order stays Pending".
 *
 * 1. decompose() the bugfix → print the plan.
 * 2. Scheduler orders the subtasks respecting dependencies.
 * 3. Selection ranks 4 seed agents for the investigation subtask.
 * 4. Orchestrator decides the next action for a few task states.
 */
import {
  decompose,
  Scheduler,
  rankCandidates,
  decideNextAction,
  createHandoff,
  choosePattern,
} from '../src/index';
import type { Agent } from '@ai-factory/core';

const plan = decompose({
  title: 'payment success but order stays Pending',
  goal: 'Orders transition to PAID when the payment gateway reports success',
  kind: 'bugfix',
  constraints: ['no downtime', 'idempotent order-state transitions'],
});

console.log('=== DECOMPOSITION PLAN ===');
console.log(`goal: ${plan.goal}\n`);
console.log('acceptance criteria:');
for (const ac of plan.acceptanceCriteria) console.log(`  - ${ac}`);
console.log('\nrisks:');
for (const r of plan.risks) console.log(`  - ${r}`);
console.log('\nsubtasks:');
plan.subtasks.forEach((s, i) =>
  console.log(`  ${i + 1}. [${s.kind}] ${s.title} (~${s.estimate})`),
);
console.log('\ndependencies:');
for (const d of plan.dependencies)
  console.log(`  subtask ${d.from + 1} ${d.kind} subtask ${d.to + 1}`);
console.log(`\nrequired specialists: ${plan.requiredSpecialists.join(', ')}`);
console.log(`test strategy: ${plan.testStrategy}`);
console.log(`deployment strategy: ${plan.deploymentStrategy}`);

// ---- 2. Scheduler: turn the plan into schedulable tasks ----
const scheduler = new Scheduler({ concurrencyLimit: 2 });
plan.subtasks.forEach((s, i) => {
  scheduler.enqueue({
    id: `sub-${i + 1}`,
    priority: i < 2 ? 'P1' : 'P2',
    dependsOn: plan.dependencies
      .filter((d) => d.from === i)
      .map((d) => `sub-${d.to + 1}`),
  });
});

console.log('\n=== SCHEDULER (concurrency 2) ===');
const execOrder: string[] = [];
for (let round = 1; round <= 6; round++) {
  const batch = scheduler.nextBatch();
  if (batch.length === 0) break;
  console.log(`round ${round}: start ${batch.join(', ')}`);
  execOrder.push(...batch);
  for (const id of batch) {
    scheduler.start(id);
    scheduler.finish(id);
  }
}
console.log(`execution order: ${execOrder.join(' -> ')}`);

// ---- 3. Agent selection: rank 4 seed agents ----
function seed(overrides: Partial<Agent>): Agent {
  return {
    id: 'x',
    name: 'x',
    displayName: 'X',
    jobTitle: 'Engineer',
    department: 'eng',
    parentAgentId: null,
    mission: '',
    instructions: '',
    skills: [],
    rules: [],
    model: 'm',
    reasoningLevel: 'MEDIUM',
    tools: [],
    permissions: [],
    autonomyLevel: 2,
    status: 'IDLE',
    version: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

const agents: Agent[] = [
  seed({
    id: 'be',
    jobTitle: 'Backend Engineer',
    skills: ['nodejs', 'payments'],
    tools: ['git'],
    permissions: ['filesystem.read', 'filesystem.write'],
    autonomyLevel: 3,
  }),
  seed({
    id: 'db',
    jobTitle: 'DB Specialist',
    skills: ['sql', 'transactions'],
    tools: ['psql'],
    permissions: ['database.read'],
    autonomyLevel: 3,
  }),
  seed({
    id: 'pg',
    jobTitle: 'PostgreSQL Specialist',
    skills: ['postgresql', 'transactions', 'locking'],
    tools: ['psql', 'pg_stat_statements'],
    permissions: ['database.read', 'database.write'],
    autonomyLevel: 4,
  }),
  seed({
    id: 'qa',
    jobTitle: 'QA Engineer',
    skills: ['testing', 'regression'],
    tools: ['playwright'],
    permissions: ['filesystem.read'],
    autonomyLevel: 2,
  }),
];

console.log('\n=== AGENT SELECTION (investigate subtask) ===');
const ranked = rankCandidates(
  agents,
  {
    requiredSkills: ['transactions', 'locking'],
    requiredTools: ['psql'],
    requiredPermissions: ['database.read'],
    complexity: 4,
    domainHint: 'payment transaction handling bug',
  },
  { performances: [{ agentId: 'pg', successRate: 0.92 }] },
);
for (const r of ranked) {
  console.log(
    `  ${r.agent.jobTitle.padEnd(22)} score=${r.score.toFixed(1)} ` +
      `(skills ${r.breakdown.skills.toFixed(0)}, tools ${r.breakdown.tools.toFixed(0)}, ` +
      `perms ${r.breakdown.permissions.toFixed(0)}, role ${r.breakdown.role.toFixed(0)})`,
  );
}

// ---- 4. Next-action decisions + handoff + pattern ----
console.log('\n=== NEXT ACTIONS ===');
for (const status of ['TODO', 'IN_PROGRESS', 'QA_FAILED', 'BLOCKED', 'DONE'] as const) {
  console.log(`  ${status.padEnd(12)} -> ${decideNextAction({ status, evidence: [], failures: 1 })}`);
}

const handoff = createHandoff({
  from: 'tech-lead',
  to: ranked[0]!.agent.id,
  taskId: 'task-1042',
  reason: 'deep transaction/locking expertise required for the investigation subtask',
  contextSummary: 'payment callback succeeds but order row never leaves Pending; see plan above',
});
console.log('\n=== HANDOFF ===');
console.log(`  ${handoff.from} -> ${handoff.to} @ ${handoff.at}`);
console.log(`  reason: ${handoff.reason}`);

console.log('\n=== PATTERN ===');
console.log(
  `  plan pattern: ${choosePattern({ subtaskCount: plan.subtasks.length, fanOut: false, sequentialPipeline: true })}`,
);
console.log('demo complete.');
