/**
 * Demo: the spec §25 coder loop, scripted without an LLM.
 *
 *  Demo 1 — RETRY: the coder loop hits a failing test twice, reads the
 *           failure, modifies, re-tests, and passes.
 *  Demo 2 — STAGNATION: the same error signature 3 times → LOOP_STAGNATION
 *           → auto-escalate.
 *
 * Run: node packages/runtime/dist/demo/demo.js
 */
import {
  AgentLoop,
  Harness,
  LoopPhase,
  PhaseResult,
  StubAdapter,
  runAgent,
  type Agent,
  type Task,
} from '../src/index';

function makeAgent(): Agent {
  return {
    id: 'agent-coder-1',
    name: 'Cody',
    displayName: 'Cody the Coder',
    jobTitle: 'AI Coder',
    department: 'engineering',
    parentAgentId: null,
    mission: 'Write correct, tested code.',
    instructions: 'Inspect → modify → test → read failure → modify → test → pass.',
    skills: ['typescript'],
    rules: [],
    model: 'code-coder',
    reasoningLevel: 'MEDIUM',
    tools: ['test', 'modify'],
    permissions: ['filesystem.read', 'filesystem.write'],
    autonomyLevel: 3,
    status: 'WORKING',
    version: 1,
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
  };
}

function makeTask(): Task {
  return {
    id: 'task-demo-1',
    projectId: 'proj-demo',
    parentTaskId: null,
    title: 'Fix the off-by-one in sum()',
    goal: 'Unit suite green.',
    description: '',
    priority: 'P2',
    severity: 'MAJOR',
    acceptanceCriteria: ['unit tests pass'],
    constraints: [],
    workspace: '/tmp/ai-factory-ws',
    creator: 'tan',
    status: 'IN_PROGRESS',
    currentAgentId: 'agent-coder-1',
    assignedAgentIds: ['agent-coder-1'],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    completedAt: null,
  };
}

function makeHarness() {
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions: ['filesystem.read', 'filesystem.write'],
    evidence: { collect: () => undefined },
    onAudit: (e) => console.log(`  [audit] ${e.action}: ${e.detail}`),
  });
}

function printTrace(label: string, trace: Array<{ phase: string; action: string; result: string }>) {
  console.log(`\n${label} trace:`);
  for (const t of trace) {
    if (t.phase === 'RUNNER') continue;
    console.log(`  ${t.phase.padEnd(10)} ${t.action} → ${t.result}`);
  }
}

async function demoRetry() {
  console.log('=== Demo 1: coder loop — failing test twice, then PASS (RETRY) ===');
  let testRuns = 0;

  const stepFn = (phase: LoopPhase): PhaseResult => {
    switch (phase) {
      case 'OBSERVE':
        return { ok: true, note: 'inspect: sum() returns 6 for [1,2,3], expected 5' };
      case 'UNDERSTAND':
        return { ok: true, note: 'off-by-one: loop starts at index 0 but adds arr[0] twice' };
      case 'PLAN':
        return { ok: true, note: 'modify: fix accumulator init, then re-test' };
      case 'ACT':
        testRuns += 1;
        return { ok: true, note: `modify + test run #${testRuns}` };
      case 'VERIFY':
        if (testRuns < 3) {
          return {
            ok: false,
            error: `test run #${testRuns}: expected 5, got 6`,
            errorSignature: 'unit:sum-off-by-one',
            note: 'read failure → modify again',
          };
        }
        return { ok: true, note: 'PASS: all unit tests green' };
      case 'EVALUATE':
        return { ok: true, decision: 'COMPLETE', note: 'acceptance criteria met' };
    }
  };

  const result = await runAgent({
    agent: makeAgent(),
    task: makeTask(),
    harness: makeHarness(),
    adapter: new StubAdapter([]),
    routeRequest: {
      taskType: 'coding',
      complexity: 3,
      requiredTools: [],
      latencyPref: 'low',
      costPref: 'high',
      privacy: 'internal',
      needsReasoning: true,
      contextNeeded: 'medium',
      needsVision: false,
      currentUsage: { usedPct: 12 },
    },
    stepFn,
  });

  console.log(`outcome: ${result.outcome} | steps: ${result.steps} | reason: ${result.reason}`);
  const routing = result.evidence.find((e) => e.type === 'model_routing');
  console.log(`routed model: ${String(routing?.payload['primary'])}`);
  printTrace('Demo 1', result.trace);
}

async function demoStagnation() {
  console.log('\n=== Demo 2: same error 3× → LOOP_STAGNATION → auto-escalate ===');
  const loop = new AgentLoop({
    budgets: { maxSteps: 100, timeMs: 60_000, maxRetries: 10 },
  });
  const result = await runAgent({
    agent: makeAgent(),
    task: makeTask(),
    harness: makeHarness(),
    adapter: new StubAdapter([]),
    loop,
    stepFn: () => ({
      ok: false,
      error: 'test run: expected 5, got 6 (again)',
      errorSignature: 'unit:sum-off-by-one',
      note: 'stuck: same fix, same failure',
    }),
  });

  console.log(`outcome: ${result.outcome} | steps: ${result.steps}`);
  console.log(`reason: ${result.reason}`);
  printTrace('Demo 2', result.trace);
}

async function main() {
  await demoRetry();
  await demoStagnation();
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
