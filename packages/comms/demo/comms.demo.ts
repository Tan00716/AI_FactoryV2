/**
 * Demo: Coder → Reviewer → QA handoff chain over @ai-factory/comms.
 *
 * Assignment → (ArtifactRef) → Handoff → Report, all sharing one
 * correlationId, then export the full task trace for auditing.
 *
 * Run: node packages/comms/dist/demo/comms.demo.js
 */
import { Channel } from '../src/index';

const channel = new Channel();

// 1. Orchestrator assigns work to the Coder.
const assignment = channel.post({
  taskId: 'task-auth-login',
  from: 'orchestrator',
  to: 'coder',
  payload: {
    kind: 'assignment',
    title: 'Implement OAuth login',
    description: 'Add OAuth login flow with PKCE to the web app.',
    requirements: ['unit tests', 'docs'],
  },
});
console.log(`[assignment] ${assignment.id} ${assignment.from} → ${assignment.to}`);

// 2. Coder publishes the PR artifact for the Reviewer.
channel.post({
  taskId: 'task-auth-login',
  from: 'coder',
  to: 'reviewer',
  correlationId: assignment.correlationId,
  payload: {
    kind: 'artifact_ref',
    artifactId: 'pr-42',
    artifactType: 'PULL_REQUEST',
    uri: 'https://git.example.com/ai-factory/pull/42',
    summary: 'OAuth login with PKCE, tests included',
  },
});
console.log(`[artifact_ref] coder → reviewer (pr-42)`);

// 3. Reviewer hands the reviewed work off to QA.
channel.post({
  taskId: 'task-auth-login',
  from: 'reviewer',
  to: 'qa',
  correlationId: assignment.correlationId,
  payload: {
    kind: 'handoff',
    fromRole: 'reviewer',
    toRole: 'qa',
    summary: 'PR-42 reviewed and approved; ready for verification.',
    context: { pullRequest: 'pr-42', reviewVerdict: 'approved' },
  },
});
console.log(`[handoff] reviewer → qa`);

// 4. QA reports the verification result back.
channel.post({
  taskId: 'task-auth-login',
  from: 'qa',
  to: 'orchestrator',
  correlationId: assignment.correlationId,
  payload: {
    kind: 'report',
    title: 'QA verification report',
    verdict: 'pass',
    summary: 'OAuth login flow verified end-to-end; 14/14 tests pass.',
  },
});
console.log(`[report] qa → orchestrator (verdict: pass)`);

// 5. Follow the whole handoff chain by correlationId.
const chain = channel.traceChain(assignment.correlationId);
console.log(`\nchain ${assignment.correlationId}: ${chain.length} messages`);
for (const m of chain) {
  console.log(`  ${m.id} [${m.payload.kind}] ${m.from} → ${m.to}`);
}

// 6. Export the complete trace for run/trace auditing.
const trace = channel.exportTrace('task-auth-login');
console.log(`\n=== trace for task ${trace.taskId} ===`);
console.log(`messages: ${trace.messageCount}`);
console.log(`participants: ${trace.participants.join(', ')}`);
console.log(`kind counts: ${JSON.stringify(trace.kindCounts)}`);
console.log('--- messages ---');
for (const m of trace.messages) {
  console.log(
    `${m.id} | corr=${m.correlationId} | ${m.from} → ${m.to} | ${m.payload.kind}`,
  );
}
