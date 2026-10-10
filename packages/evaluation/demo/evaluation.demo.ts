/**
 * Evaluation engine demo — spec §57 (Evaluation Engine) and §58
 * (Agent Improvement) end to end.
 *
 *  1. A simulated finished task is evaluated → EvaluationResult with the
 *     §57 metrics, weighted score, and verdict.
 *  2. A few more evaluations are recorded so the AgentProfiler can show an
 *     aggregated AgentProfile for the agent.
 *  3. Failure analysis produces Lessons; they are persisted through the
 *     LessonSink interface, here wired to the real @ai-factory/memory
 *     MemoryStore (the evaluation package itself never hard-depends on it).
 *  4. An improvement proposal is filed and walked through the governance
 *     state machine: applying before approval is refused, then it is
 *     approved and applied.
 *
 * Run after building both packages:
 *   npm run build -w @ai-factory/memory && npm run build -w @ai-factory/evaluation
 *   node packages/evaluation/dist/demo/evaluation.demo.js
 */
import { MemoryStore, NewMemoryEntry } from '@ai-factory/memory';
import {
  AgentProfiler,
  EvaluationEngine,
  EvaluationResult,
  ImprovementProposal,
  Lesson,
  LessonPublisher,
  LessonSink,
  ProposalBoard,
  TaskEvaluationInput,
} from '../src/index';

let now = Date.now();
const clock = { now: () => now };
const advance = (ms: number): void => {
  now += ms;
};

const engine = new EvaluationEngine(clock);
const profiler = new AgentProfiler(clock);

function taskEvidence(taskId: string, overrides: Partial<TaskEvaluationInput> = {}): TaskEvaluationInput {
  return {
    taskId,
    agentId: 'backend-01',
    summary: 'Implemented the orders API endpoint, added unit tests, deployed to staging.',
    evidenceIds: ['ev-test-run-451', 'ev-review-118'],
    success: true,
    tests: { passed: 24, total: 24 },
    regressions: 0,
    reviewRounds: 1,
    reviewRejections: 0,
    fixLoops: 1,
    durationMs: 3_600_000,
    tokensUsed: 45_000,
    toolCalls: 120,
    toolErrors: 0,
    completionClaims: 1,
    falseCompletions: 0,
    deployments: 1,
    rollbacks: 0,
    decisions: 3,
    escalations: 0,
    ...overrides,
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

console.log('== 1. evaluate a simulated completed task ==');
// Seed two earlier evaluations so the agent profile has history.
profiler.record(engine.evaluateTask(taskEvidence('task-101')));
advance(3_600_000);
profiler.record(
  engine.evaluateTask(
    taskEvidence('task-102', {
      success: true,
      fixLoops: 3,
      reviewRounds: 2,
      reviewRejections: 1,
      summary: 'Refactored auth middleware; needed 3 fix loops and one rejected review.',
    }),
  ),
);
advance(3_600_000);

// The task under evaluation: mostly good, but with a false completion
// claim and a couple of regressions — worth learning from.
const result: EvaluationResult = engine.evaluateTask(
  taskEvidence('task-103', {
    fixLoops: 2,
    regressions: 2,
    reviewRounds: 2,
    reviewRejections: 1,
    toolCalls: 100,
    toolErrors: 5,
    completionClaims: 2,
    falseCompletions: 1,
    summary: 'Implemented the orders API. Two regressions slipped in; one "done" claim was premature.',
  }),
);

console.log(`task: ${result.taskId}  agent: ${result.agentId}`);
console.log(`verdict: ${result.verdict}  score: ${result.score}`);
for (const [k, v] of Object.entries(result.metrics)) {
  console.log(`  ${k}: ${typeof v === 'number' && v <= 1 ? pct(v) : v}`);
}

console.log('\n== 2. agent profile (aggregated across evaluations) ==');
const profile = profiler.record(result);
console.log(`agent: ${profile.agentId}`);
console.log(`  evaluations:      ${profile.evaluations}`);
console.log(`  success rate:     ${pct(profile.successRate)}`);
console.log(`  first-pass QA:    ${pct(profile.firstPassQaRate)}`);
console.log(`  review rejection: ${pct(profile.reviewRejectionRate)}`);
console.log(`  avg repair loops: ${profile.avgRepairLoops}`);
console.log(`  false completion:${pct(profile.falseCompletionRate)}`);

console.log('\n== 3. failure analysis → lessons → memory sink ==');
// The LessonSink seam, wired to the real memory package (built dist).
const memoryStore = new MemoryStore(clock);
const memorySink: LessonSink = {
  saveLesson(lesson: Lesson): void {
    const entry: NewMemoryEntry = {
      scope: 'task',
      scopeId: lesson.taskId,
      type: 'Lesson',
      title: lesson.title,
      content: `[${lesson.severity}] ${lesson.content}`,
      source: `evaluation:${lesson.taskId}`,
      confidence: lesson.confidence,
      createdBy: lesson.agentId,
      evidenceIds: lesson.evidenceIds,
      applicableScope: 'project:shop',
    };
    memoryStore.write(entry);
  },
};

const publisher = new LessonPublisher(memorySink, clock);
const lessons = publisher.publish(result);
console.log(`generated ${lessons.length} lesson(s) from task-103:`);
for (const l of lessons) {
  console.log(`  [${l.severity}] "${l.title}" (confidence ${l.confidence})`);
}
console.log(`memory store now holds ${memoryStore.size()} entr(y/ies)`);

console.log('\n== 4. improvement proposal → governance state machine ==');
const board = new ProposalBoard(clock);
const proposal: ImprovementProposal = board.propose({
  kind: 'skill-improvement',
  title: 'Gate "done" claims on a green regression run',
  description:
    'Add a checklist step to the deploy skill: no completion claim is sent ' +
    'until the full regression suite is green.',
  proposedBy: 'backend-01',
  lessonIds: lessons.map((l) => l.lessonId),
});
console.log(`proposed: "${proposal.title}" → ${proposal.status}`);

// §58 governance: applying before approval is refused — never silently applied.
try {
  board.apply(proposal.proposalId);
  console.log('ERROR: unapproved proposal was applied!');
} catch (err) {
  console.log(`apply before approval refused: ${(err as Error).message}`);
}

const approved = board.approve(proposal.proposalId, 'human:cto');
console.log(`approved by ${approved.decidedBy} → ${approved.status}`);
const applied = board.apply(proposal.proposalId);
console.log(`applied → ${applied.status}`);

// A critical org-rule change needs explicit human approval; agents cannot
// approve it and policy cannot auto-approve it.
const critical = board.propose({
  kind: 'org-rule',
  title: 'Remove the human review gate on Fridays',
  description: 'Skip mandatory review to ship faster before the weekend.',
  proposedBy: 'backend-01',
});
try {
  board.approve(critical.proposalId, 'backend-01');
} catch (err) {
  console.log(`agent self-approval of org rule refused: ${(err as Error).message}`);
}
console.log(`critical proposal still ${board.get(critical.proposalId)!.status} — pending human decision`);
