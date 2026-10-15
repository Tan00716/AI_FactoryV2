/**
 * @ai-factory/evaluation — auto-governance end-to-end (spec §45.4 / INV-28).
 *
 * Drives the real ImprovementLoop through the full stage chain:
 * a failing version is auto-disabled while a running case on another
 * version stays pinned; the failing case switches to an approved
 * fallback via an explicit, admission-checked migration; disabled
 * versions can never be (re-)activated or promoted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImprovementLoop,
  LoopError,
  type EvaluationResult,
  type EvaluationRun,
  type Lesson,
} from '../src/index';

function makeClock() {
  let t = 2000;
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

/** Drive a case to POLICY_APPROVAL (fallback-eligible once approved). */
function driveToApprove(loop: ImprovementLoop, version: string): string {
  let c = loop.start(`task-${version}`, { verifiedBy: 'human:qa' });
  c = loop.recordOutcomeEval(c.caseId, evalResult(), 'eval-service');
  c = loop.addLesson(c.caseId, lesson(), 'analyst');
  c = loop.fileProposal(c.caseId, {
    kind: 'skill-improvement',
    title: `improve-${version}`,
    description: 'd',
    proposedBy: 'agent-1',
  });
  c = loop.runIndependentEval(c.caseId, {
    regression: run({ runId: `reg-${version}` }),
    security: run({ runId: `sec-${version}` }),
    by: 'eval-service',
  });
  c = loop.versionProposal(c.caseId, version, 'agent-1');
  c = loop.approvePolicy(c.caseId, 'human:cto');
  return c.caseId;
}

/** Drive a case to LIMITED_ACTIVATION on the given version. */
function driveToActivate(loop: ImprovementLoop, version: string, employees: string[]): string {
  const caseId = driveToApprove(loop, version);
  loop.activateLimited(caseId, { employees, note: 'canary', by: 'human:cto' });
  return caseId;
}

describe('auto-governance end-to-end — §45.4', () => {
  it('failing version auto-disabled; running case stays pinned; fallback switched explicitly', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });

    // v0: approved fallback (driven to POLICY_APPROVAL, never activated).
    driveToApprove(loop, 'v0');

    // Case A on v1: healthy canary observations.
    const caseA = driveToActivate(loop, 'v1', ['emp-a']);
    loop.observe(caseA, { note: 'ok', success: true, by: 'eval-service' });
    loop.observe(caseA, { note: 'ok', success: true, by: 'eval-service' });

    // Case B on v2: failing canary observations.
    const caseB = driveToActivate(loop, 'v2', ['emp-b']);
    loop.observe(caseB, { note: 'canary crash', success: false, by: 'eval-service' });
    loop.observe(caseB, { note: 'canary crash again', success: false, by: 'eval-service' });

    const { loop: after, decisions } = loop.autoGovern(caseB, { by: 'policy-engine' });
    const actions = decisions.map((d) => d.action).sort();
    assert.deepEqual(actions, ['disable-version', 'downgrade-autonomy', 'switch-to-fallback']);

    // v2 is disabled; v1 untouched.
    const versions = new Map(loop.versions().map((v) => [v.version, v]));
    assert.equal(versions.get('v2')!.status, 'DISABLED');
    assert.equal(versions.get('v1')!.status, 'ACTIVE');
    assert.equal(versions.get('v0')!.status, 'ACTIVE');

    // Case B explicitly migrated to the approved fallback v0.
    assert.equal(after.version, 'v0');
    assert.equal(after.onFallbackVersion, true);
    const trail = after.admissionChecks.map((a) => a.details).join('\n');
    assert.match(trail, /auto-governance\[disable-version\]/);
    assert.match(trail, /explicit migration v2 → v0/);

    // Case A — the running case — stays pinned to v1.
    assert.equal(loop.status(caseA).version, 'v1');
    assert.equal(loop.status(caseA).onFallbackVersion, undefined);

    // A new case cannot (re-)activate the disabled v2.
    const caseC = driveToApprove(loop, 'v2');
    assert.throws(
      () => loop.activateLimited(caseC, { employees: ['emp-c'], note: 'x', by: 'human:cto' }),
      /DISABLED_VERSION/,
    );

    // Case B cannot promote (its observations contain failures).
    assert.throws(() => loop.promote(caseB, 'human:cto'), /containing failures/);

    // Second auto-govern is a no-op: already disabled, on fallback, downgraded.
    const second = loop.autoGovern(caseB, { by: 'policy-engine' });
    assert.deepEqual(second.decisions, []);
  });

  it('a disabled version can never be promoted, even with passing observations', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });

    // Case D on v3: all-passing observations.
    const caseD = driveToActivate(loop, 'v3', ['emp-d']);
    loop.observe(caseD, { note: 'ok', success: true, by: 'eval-service' });

    // Case E on v3: one failing observation → v3 auto-disabled (no fallback).
    const caseE = driveToActivate(loop, 'v3', ['emp-e']);
    loop.observe(caseE, { note: 'canary crash', success: false, by: 'eval-service' });
    const { decisions } = loop.autoGovern(caseE, { by: 'policy-engine' });
    assert.deepEqual(decisions.map((d) => d.action), ['disable-version']);

    // Case D — running on v3 with passing observations — cannot promote it.
    assert.throws(() => loop.promote(caseD, 'human:cto'), /DISABLED_VERSION/);
    // ...and stays pinned to v3 (nothing auto-migrated it).
    assert.equal(loop.status(caseD).version, 'v3');
  });

  it('explicit migration moves a pinned case; disabled targets are refused', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    const caseA = driveToActivate(loop, 'v1', ['emp-a']);

    const migrated = loop.migrateVersion(caseA, 'v1b', {
      by: 'human:cto',
      reason: 'operator-requested move',
    });
    assert.equal(migrated.version, 'v1b');
    const last = migrated.admissionChecks[migrated.admissionChecks.length - 1];
    assert.match(last.details, /explicit migration v1 → v1b/);

    // Disable v9 via a failing case, then refuse migration into it.
    const caseF = driveToActivate(loop, 'v9', ['emp-f']);
    loop.observe(caseF, { note: 'boom', success: false, by: 'eval-service' });
    loop.autoGovern(caseF, { by: 'policy-engine' });
    assert.throws(
      () => loop.migrateVersion(caseA, 'v9', { by: 'human:cto', reason: 'x' }),
      /DISABLED_VERSION/,
    );
    assert.equal(loop.status(caseA).version, 'v1b');
  });

  it('after explicit migration, the old version\u2019s failures do not disable the new one', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    const caseA = driveToActivate(loop, 'v7', ['emp-a']);
    loop.observe(caseA, { note: 'boom', success: false, by: 'eval-service' });

    // Explicit migration BEFORE any auto-governance runs.
    loop.migrateVersion(caseA, 'v8', { by: 'human:cto', reason: 'manual move' });
    loop.observe(caseA, { note: 'ok on v8', success: true, by: 'eval-service' });

    // The v7 failure must not disable v8: observations are version-tagged.
    const { decisions } = loop.autoGovern(caseA, { by: 'policy-engine' });
    assert.deepEqual(decisions, []);
    const versions = new Map(loop.versions().map((v) => [v.version, v]));
    assert.equal(versions.get('v8')!.status, 'ACTIVE');
    assert.equal(versions.get('v7')!.status, 'ACTIVE');
    assert.equal(loop.status(caseA).version, 'v8');
  });

  it('auto-governance refuses to run before a version is pinned', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    let c = loop.start('task-x', { verifiedBy: 'human:qa' });
    assert.throws(
      () => loop.autoGovern(c.caseId, { by: 'policy-engine' }),
      /LIMITED_ACTIVATION\/OBSERVE/,
    );
    void c;
  });

  it('LoopError is thrown (not a silent no-op) on misuse', () => {
    const loop = new ImprovementLoop({ now: makeClock().now });
    assert.throws(() => loop.autoGovern('nope', { by: 'x' }), LoopError);
  });
});
