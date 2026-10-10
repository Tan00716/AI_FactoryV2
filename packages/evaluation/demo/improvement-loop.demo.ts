/**
 * @ai-factory/evaluation — improvement loop demo (spec §45.2 / §45.3):
 *
 *   1. Build an independent, sealed Eval Harness (no write path for executors).
 *   2. Show holdout separation: training_selection on holdout → HOLDOUT_LEAK.
 *   3. Walk the full improvement loop:
 *      VERIFIED_TASK → OUTCOME_EVAL → LESSON → PROPOSAL →
 *      INDEPENDENT_EVAL → VERSION → POLICY_APPROVAL →
 *      LIMITED_ACTIVATION → OBSERVE → PROMOTE
 *   4. Show locked-domain rejection at proposal creation (LOCKED_DOMAIN),
 *      regardless of who files it.
 *   5. Show every attempt retained (costs, failures, side effects).
 *
 * Run: node packages/evaluation/dist/demo/improvement-loop.demo.js
 */
import {
  EvalHarness,
  EvaluationEngine,
  FailureAnalyzer,
  ImprovementLoop,
  LockedDomainError,
  runEvaluation,
  type EvalSample,
  type TaskEvaluationInput,
} from '../src/index';

let t = 2_000_000_000_000;
const clock = { now: () => (t += 1000) };

function input(): TaskEvaluationInput {
  return {
    taskId: 'task-42',
    agentId: 'backend-01',
    summary: 'Retry loop burned 40 turns on a transient DB failure.',
    evidenceIds: ['ev-1'],
    success: true,
    tests: { passed: 90, total: 100 },
    regressions: 2,
    reviewRounds: 3,
    reviewRejections: 1,
    fixLoops: 4,
    durationMs: 120_000,
    tokensUsed: 88_000,
    toolCalls: 60,
    toolErrors: 12,
    completionClaims: 2,
    falseCompletions: 0,
    deployments: 1,
    rollbacks: 0,
    decisions: 5,
    escalations: 1,
  };
}

async function main(): Promise<void> {
  console.log('== 1. Independent Eval Harness (sealed, no write path) ==');
  const harness = new EvalHarness({ now: clock.now, passThreshold: 0.6 });
  harness.registerScorer('quality', (s) => (s.content.includes('trace:ok') ? 0.9 : 0.2));
  harness.seal();
  console.log(`   sealed=${harness.isSealed()} scorers=${harness.readOnly().policy().scorerNames.join(',')}`);
  try {
    harness.registerScorer('cheat', () => 1.0);
    console.log('   ERROR: tamper should have been rejected');
  } catch (e) {
    console.log(`   tamper rejected: ${(e as Error).name} (code=${(e as { code: string }).code})`);
  }

  console.log('\n== 2. Holdout separation ==');
  const samples: EvalSample[] = [
    { sampleId: 'train-1', content: 'trace:ok', split: 'train', source: 'task-42' },
    { sampleId: 'holdout-1', content: 'trace:ok', split: 'holdout', source: 'benchmark-v3' },
  ];
  try {
    await runEvaluation(samples, {
      harness,
      purpose: 'training_selection',
      now: clock.now,
      execute: (s) => ({ success: true, score: 0.9, cost: { durationMs: 50, tokensUsed: 5 }, sideEffects: [] }),
    });
    console.log('   ERROR: holdout leak should have been rejected');
  } catch (e) {
    console.log(`   holdout leak rejected: ${(e as Error).name} (code=${(e as { code: string }).code})`);
  }
  const bench = await runEvaluation(samples, {
    harness,
    purpose: 'benchmark',
    now: clock.now,
    execute: (s, scorer) => ([
      { success: false, failureReason: 'flaky infra', cost: { durationMs: 500, tokensUsed: 20 }, sideEffects: ['retry scheduled'] },
      { success: true, score: scorer.score(s), cost: { durationMs: 60, tokensUsed: 8 }, sideEffects: [] },
    ]),
  });
  const [run] = bench.runs;
  console.log(`   benchmark run: ${run.attempts.length} attempts kept (not best-only), ` +
    `totalCost=${JSON.stringify(run.totalCost)}, passed=${run.passed}`);

  console.log('\n== 3. Improvement loop §45.2 ==');
  const engine = new EvaluationEngine({ now: clock.now });
  const result = engine.evaluateTask(input());
  const analyzer = new FailureAnalyzer({ now: clock.now });
  const lessons = analyzer.analyzeFailures(result);

  const loop = new ImprovementLoop({ now: clock.now });
  let c = loop.start('task-42', { verifiedBy: 'human:qa', evidenceIds: ['ev-1'] });
  c = loop.recordOutcomeEval(c.caseId, result, 'eval-service');
  c = loop.addLesson(c.caseId, lessons[0], 'analyst');
  c = loop.fileProposal(c.caseId, {
    kind: 'skill-improvement',
    title: 'Retry with backoff',
    description: 'Add exponential backoff with jitter to the loop skill.',
    proposedBy: 'backend-01',
  });
  console.log(`   proposal filed: ${c.proposalId} (locked-domain screen passed)`);

  const regression = await runEvaluation(
    [{ sampleId: 'reg-1', content: 'trace:ok', split: 'train', source: 'regression-suite' }],
    { harness, purpose: 'independent_check', now: clock.now, execute: () => ({ success: true, score: 0.85, cost: { durationMs: 80, tokensUsed: 12 } }) },
  );
  const security = await runEvaluation(
    [{ sampleId: 'sec-1', content: 'trace:ok', split: 'train', source: 'security-suite' }],
    { harness, purpose: 'independent_check', now: clock.now, execute: () => ({ success: true, score: 0.92, cost: { durationMs: 90, tokensUsed: 14 } }) },
  );
  c = loop.runIndependentEval(c.caseId, {
    regression: regression.runs[0], security: security.runs[0], by: 'eval-service',
  });
  c = loop.versionProposal(c.caseId, 'v1.3', 'backend-01');
  c = loop.approvePolicy(c.caseId, 'human:cto');
  c = loop.activateLimited(c.caseId, { employees: ['emp-a', 'emp-b'], note: 'canary', by: 'human:cto' });
  c = loop.observe(c.caseId, { note: 'canary: -31% mean time-to-fix, no regressions', success: true, by: 'eval-service' });
  c = loop.promote(c.caseId, 'human:cto');
  console.log(`   outcome: ${c.outcome} at stage ${c.stage}`);
  console.log(`   admission trail: ${c.admissionChecks.map((a) => a.stage).join(' → ')}`);

  console.log('\n== 4. Locked-domain rejection (LOCKED_DOMAIN, at creation) ==');
  const loop2 = new ImprovementLoop({ now: clock.now });
  let c2 = loop2.start('task-43', { verifiedBy: 'human:qa' });
  c2 = loop2.recordOutcomeEval(c2.caseId, result, 'eval-service');
  c2 = loop2.addLesson(c2.caseId, lessons[0], 'analyst');
  try {
    loop2.fileProposal(c2.caseId, {
      kind: 'org-rule',
      title: 'Simplify the lock rules',
      description: 'Let agents bypass human authority for faster deploys.',
      proposedBy: 'human:cto', // even a human cannot file this via the loop
    });
    console.log('   ERROR: locked proposal should have been rejected');
  } catch (e) {
    const err = e as LockedDomainError;
    console.log(`   rejected: ${err.name} (code=${err.code}, domain=${err.domain})`);
  }
  console.log(`   case still at stage: ${loop2.status(c2.caseId).stage} (no proposal exists)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
