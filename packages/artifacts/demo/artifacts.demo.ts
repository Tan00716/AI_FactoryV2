/**
 * Artifact system demo (spec §23).
 *
 * For one task: create a CODE_CHANGE and a TEST_RESULT, link them, seal
 * both, then fire a TASK_COMPLETED workflow event — the hook
 * auto-generates a FINAL_REPORT draft linked to the chain. Finally prints
 * the task's artifact chain.
 *
 * Run: node dist/demo/artifacts.demo.js   (after tsc -p tsconfig.json)
 */
import {
  Artifact,
  ArtifactStore,
  ArtifactWorkflowHooks,
} from '../src/index';

const TASK_ID = 'task-demo-4242';

function line(a: Artifact, store: ArtifactStore): string {
  const links = a.relatedIds
    .map((id) => store.get(id))
    .filter((x): x is Artifact => x !== undefined)
    .map((x) => x.type)
    .join(', ');
  return `  [${a.status}] ${a.type} "${a.title}"` + (links ? `  → linked: ${links}` : '');
}

function main(): void {
  // Fixed clock keeps the demo output deterministic.
  const store = new ArtifactStore({ now: () => Date.parse('2026-10-09T08:00:00Z') });
  const hooks = new ArtifactWorkflowHooks(store);

  console.log(`Task ${TASK_ID}: building the artifact chain…`);

  // 1. Code change produced by the task.
  const code = store.create({
    taskId: TASK_ID,
    type: 'CODE_CHANGE',
    title: 'Add retry budget to coder loop',
    fields: {
      filesChanged: ['packages/qa/src/loop.ts', 'packages/qa/tests/loop.test.ts'],
      diffSummary: 'adds maxAttempts option and stagnation detection',
      changeType: 'feature',
    },
    createdBy: 'coder-agent',
  });
  console.log('created', line(code, store));

  // 2. Test result for that change, linked at creation time.
  const tests = store.create({
    taskId: TASK_ID,
    type: 'TEST_RESULT',
    title: 'qa loop tests — all green',
    fields: { suite: 'qa-loop', passed: 34, failed: 0, summary: 'all loop tests pass' },
    createdBy: 'qa-agent',
    relatedIds: [code.id],
  });
  console.log('created', line(tests, store));

  // 3. Task completes → workflow hook auto-generates the FINAL_REPORT
  //    draft, linking the evidence chain together. (Must happen before
  //    sealing: sealed artifacts are immutable and refuse new links.)
  const [report] = hooks.onWorkflowEvent({
    kind: 'TASK_COMPLETED',
    taskId: TASK_ID,
    payload: {
      title: 'Final report: retry budget for coder loop',
      summary: 'Implemented maxAttempts with stagnation detection; all tests pass.',
      outcomes: ['loop.ts maxAttempts option', '34 passing tests'],
      relatedArtifactIds: [code.id, tests.id],
    },
  });
  console.log('hook generated', line(report, store));

  // 4. Seal everything: the evidence chain is now immutable.
  for (const a of [code.id, tests.id, report.id]) store.seal(a);
  console.log('sealed CODE_CHANGE, TEST_RESULT and FINAL_REPORT');

  // 5. Print the full artifact chain for the task.
  console.log(`\nArtifact chain for ${TASK_ID}:`);
  for (const a of store.listByTask(TASK_ID)) {
    console.log(line(a, store));
  }
  console.log(`\n${store.size()} artifacts total; sealed: ${store.query({ status: 'SEALED' }).length}`);
}

main();
