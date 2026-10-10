/** @ai-factory/evaluation — improvement closed loop (spec §45.2). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImprovementLoop,
  LoopError,
  LockedDomainError,
  LOOP_STAGES,
  type EvaluationResult,
  type EvaluationRun,
  type Lesson,
} from '../src/index';

function makeClock() {
  let t = 1000;
  return { now: () => (t += 1) };
}

function evalResult(over: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluationId: 'eval_1',
    taskId: 'task-1',
    agentId: 'agent-1',
    summary: 'done',
    evidenceIds: ['ev1'],
    metrics: {
      taskSuccess: 1, testPassRate: 0.9, regressionRate: 0, reviewRejectionRate: 0,
      loopEfficiency: 1, durationMs: 100, tokenUsage: 10, toolErrorRate: 0,
      falseCompletionRate: 0, rollbackRate: 0, humanEscalationRate: 0,
    },
    score: 0.9,
    verdict: 'GOOD',
    repairLoops: 0,
    evaluatedAt: 1,
    ...over,
  };
}

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    lessonId: 'lesson_1',
    taskId: 'task-1',
    agentId: 'agent-1',
    title: 'Retry transient failures with backoff',
    content: '…',
    severity: 'warning',
    confidence: 0.8,
    evidenceIds: ['ev1'],
    createdAt: 1,
    ...over,
  };
}

function run(over: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    runId: 'run_1',
    sampleId: 'sample-1',
    purpose: 'independent_check',
    attempts: [
      {
        attemptId: 'att_1',
        at: 1,
        cost: { durationMs: 100, tokensUsed: 10 },
        success: true,
        score: 0.9,
        sideEffects: [],
      },
    ],
    totalCost: { durationMs: 100, tokensUsed: 10 },
    bestScore: 0.9,
    passed: true,
    executedAt: 1,
    ...over,
  };
}

function driveToProposal(clock = makeClock()): { loop: ImprovementLoop; caseId: string } {
  const loop = new ImprovementLoop({ now: clock.now });
  let c = loop.start('task-1', { verifiedBy: 'human:qa', evidenceIds: ['ev1'] });
  c = loop.recordOutcomeEval(c.caseId, evalResult(), 'eval-service');
  c = loop.addLesson(c.caseId, lesson(), 'analyst');
  c = loop.fileProposal(c.caseId, {
    kind: 'skill-improvement',
    title: 'Retry with backoff',
    description: 'Add exponential backoff with jitter to the loop skill.',
    proposedBy: 'agent-1',
  });
  return { loop, caseId: c.caseId };
}

describe('ImprovementLoop — §45.2 closed loop stages', () => {
  it('walks VERIFIED_TASK → … → PROMOTE with an admission check per stage', () => {
    const clock = makeClock();
    const { loop, caseId } = driveToProposal(clock);

    let c = loop.runIndependentEval(caseId, {
      regression: run({ runId: 'run_reg' }),
      security: run({ runId: 'run_sec' }),
      by: 'eval-service',
    });
    assert.equal(c.stage, 'INDEPENDENT_EVAL');

    c = loop.versionProposal(caseId, 'v1.3', 'agent-1');
    assert.equal(c.stage, 'VERSION');
    assert.equal(c.version, 'v1.3');

    c = loop.approvePolicy(caseId, 'human:cto');
    assert.equal(c.stage, 'POLICY_APPROVAL');

    c = loop.activateLimited(caseId, {
      employees: ['emp-a', 'emp-b'],
      note: 'canary: 2 workers',
      by: 'human:cto',
    });
    assert.equal(c.stage, 'LIMITED_ACTIVATION');
    assert.deepEqual(c.limitedScope?.employees, ['emp-a', 'emp-b']);

    c = loop.observe(caseId, { note: 'no regressions on canary', success: true, by: 'eval-service' });
    assert.equal(c.stage, 'OBSERVE');

    c = loop.promote(caseId, 'human:cto');
    assert.equal(c.stage, 'PROMOTE');
    assert.equal(c.outcome, 'PROMOTED');

    // One admission check per stage visited (10 stages on the promote path).
    const stages = c.admissionChecks.map((a) => a.stage);
    assert.deepEqual(stages, [
      'VERIFIED_TASK', 'OUTCOME_EVAL', 'LESSON', 'PROPOSAL', 'INDEPENDENT_EVAL',
      'VERSION', 'POLICY_APPROVAL', 'LIMITED_ACTIVATION', 'OBSERVE', 'PROMOTE',
    ]);
    for (const check of c.admissionChecks) {
      assert.ok(check.passed);
      assert.ok(check.checkedBy);
      assert.ok(check.details);
      assert.ok(Number.isFinite(check.at));
    }
  });

  it('revert keeps the effect record', () => {
    const { loop, caseId } = driveToProposal();
    loop.runIndependentEval(caseId, { regression: run(), security: run(), by: 'eval-service' });
    loop.versionProposal(caseId, 'v1.3', 'agent-1');
    loop.approvePolicy(caseId, 'human:cto');
    loop.activateLimited(caseId, { employees: ['emp-a'], note: 'canary', by: 'human:cto' });
    loop.observe(caseId, { note: 'canary error rate +5%', success: false, by: 'eval-service' });
    const c = loop.revert(caseId, { by: 'human:cto', reason: 'canary regression' });
    assert.equal(c.stage, 'REVERT');
    assert.equal(c.outcome, 'REVERTED');
    assert.equal(c.outcomeReason, 'canary regression');
    assert.equal(c.observations.length, 1, 'effect record retained');
    assert.ok(c.admissionChecks.some((a) => a.stage === 'REVERT'));
  });

  it('promotion is blocked when an observation failed', () => {
    const { loop, caseId } = driveToProposal();
    loop.runIndependentEval(caseId, { regression: run(), security: run(), by: 'eval-service' });
    loop.versionProposal(caseId, 'v1.3', 'agent-1');
    loop.approvePolicy(caseId, 'human:cto');
    loop.activateLimited(caseId, { employees: ['emp-a'], note: 'canary', by: 'human:cto' });
    loop.observe(caseId, { note: 'flaky', success: false, by: 'eval-service' });
    assert.throws(() => loop.promote(caseId, 'human:cto'), LoopError);
    assert.equal(loop.status(caseId).outcome, undefined);
  });

  it('stages must run in order — skipping ahead throws', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    const c = loop.start('task-1', { verifiedBy: 'human:qa' });
    assert.throws(() => loop.fileProposal(c.caseId, {
      kind: 'skill-improvement', title: 'x', description: 'y', proposedBy: 'a',
    }), LoopError);
    assert.throws(() => loop.promote(c.caseId, 'human:cto'), LoopError);
  });

  it('LOCKED: fileProposal rejects a locked-domain proposal at creation', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    let c = loop.start('task-1', { verifiedBy: 'human:qa' });
    c = loop.recordOutcomeEval(c.caseId, evalResult(), 'eval-service');
    c = loop.addLesson(c.caseId, lesson(), 'analyst');
    assert.throws(
      () => loop.fileProposal(c.caseId, {
        kind: 'org-rule',
        title: 'Simplify the lock rules',
        description: 'Reduce the lock rules for faster execution.',
        proposedBy: 'agent-1',
      }),
      (err: unknown) => {
        assert.ok(err instanceof LockedDomainError);
        assert.equal(err.code, 'LOCKED_DOMAIN');
        assert.equal(err.domain, 'lock-rules');
        return true;
      },
    );
    // The case is still at LESSON: the locked proposal never existed.
    assert.equal(loop.status(c.caseId).stage, 'LESSON');
    assert.equal(loop.status(c.caseId).proposalId, undefined);
  });

  it('LOCKED: human-authority changes are rejected even when a human files them', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    let c = loop.start('task-1', { verifiedBy: 'human:qa' });
    c = loop.recordOutcomeEval(c.caseId, evalResult(), 'eval-service');
    c = loop.addLesson(c.caseId, lesson(), 'analyst');
    // Rejection happens at creation — the approver never gets a say.
    assert.throws(
      () => loop.fileProposal(c.caseId, {
        kind: 'org-rule',
        title: 'Autonomous deploys',
        description: 'Let agents remove human authority from the deploy gate.',
        proposedBy: 'human:cto',
        targetDomains: ['human-authority'],
      }),
      LockedDomainError,
    );
  });

  it('INDEPENDENT_EVAL refuses training-selection runs at the gate', () => {
    const { loop, caseId } = driveToProposal();
    assert.throws(
      () => loop.runIndependentEval(caseId, {
        regression: run({ purpose: 'training_selection' }),
        security: run(),
        by: 'eval-service',
      }),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.match((err as Error).message, /training_selection/);
        return true;
      },
    );
    assert.equal(loop.status(caseId).stage, 'PROPOSAL');
  });

  it('limited activation requires a non-empty canary scope', () => {
    const { loop, caseId } = driveToProposal();
    loop.runIndependentEval(caseId, { regression: run(), security: run(), by: 'eval-service' });
    loop.versionProposal(caseId, 'v1.3', 'agent-1');
    loop.approvePolicy(caseId, 'human:cto');
    assert.throws(
      () => loop.activateLimited(caseId, { employees: [], note: 'everyone', by: 'human:cto' }),
      LoopError,
    );
  });

  it('status exposes the full admission trail', () => {
    const { loop, caseId } = driveToProposal();
    const s = loop.status(caseId);
    assert.equal(s.caseId, caseId);
    assert.equal(s.stage, 'PROPOSAL');
    assert.ok(s.proposalId);
    assert.deepEqual(s.admissionChecks.map((a) => a.stage), [
      'VERIFIED_TASK', 'OUTCOME_EVAL', 'LESSON', 'PROPOSAL',
    ]);
  });

  it('LOOP_STAGES lists the full §45.2 pipeline', () => {
    assert.deepEqual([...LOOP_STAGES], [
      'VERIFIED_TASK', 'OUTCOME_EVAL', 'LESSON', 'PROPOSAL', 'INDEPENDENT_EVAL',
      'VERSION', 'POLICY_APPROVAL', 'LIMITED_ACTIVATION', 'OBSERVE', 'PROMOTE', 'REVERT',
    ]);
  });
});
