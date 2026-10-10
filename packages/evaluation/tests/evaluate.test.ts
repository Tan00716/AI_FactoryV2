/**
 * Tests for EvaluationEngine.evaluateTask (spec §57): evaluation records,
 * injected clock, evidence copying, and task/agent queries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationEngine, TaskEvaluationInput } from '../src/index';

function perfect(taskId: string, agentId = 'backend-01'): TaskEvaluationInput {
  return {
    taskId,
    agentId,
    summary: 'Implemented the orders endpoint with tests.',
    evidenceIds: ['ev-test-1'],
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
  };
}

describe('EvaluationEngine', () => {
  it('evaluates a perfect task as EXCELLENT with a stored record', () => {
    const engine = new EvaluationEngine({ now: () => 1_700_000_000_000 });
    const r = engine.evaluateTask(perfect('task-1'));
    assert.equal(r.taskId, 'task-1');
    assert.equal(r.agentId, 'backend-01');
    assert.equal(r.verdict, 'EXCELLENT');
    assert.equal(r.score, 1);
    assert.equal(r.evaluatedAt, 1_700_000_000_000);
    assert.equal(r.repairLoops, 1);
    assert.ok(r.evaluationId.startsWith('eval_'));
    assert.equal(engine.get(r.evaluationId)?.verdict, 'EXCELLENT');
    assert.equal(engine.size(), 1);
  });

  it('evaluates a disastrous task as FAIL', () => {
    const engine = new EvaluationEngine();
    const r = engine.evaluateTask({
      ...perfect('task-2'),
      success: false,
      tests: { passed: 0, total: 10 },
      fixLoops: 8,
      toolCalls: 50,
      toolErrors: 40,
    });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.score < 0.35);
  });

  it('uses the injected clock for evaluatedAt', () => {
    let now = 1000;
    const engine = new EvaluationEngine({ now: () => now });
    const a = engine.evaluateTask(perfect('t-a'));
    now = 2000;
    const b = engine.evaluateTask(perfect('t-b'));
    assert.equal(a.evaluatedAt, 1000);
    assert.equal(b.evaluatedAt, 2000);
  });

  it('copies evidence ids so later mutation cannot corrupt the record', () => {
    const engine = new EvaluationEngine();
    const evidenceIds = ['ev-test-1'];
    const r = engine.evaluateTask(perfect('task-3'));
    assert.deepEqual(r.evidenceIds, evidenceIds);
    evidenceIds.push('ev-evil');
    assert.deepEqual(engine.get(r.evaluationId)!.evidenceIds, ['ev-test-1']);
  });

  it('queries evaluations by task and by agent, oldest first', () => {
    let now = 1000;
    const engine = new EvaluationEngine({ now: () => now });
    engine.evaluateTask(perfect('task-A', 'agent-x'));
    now = 2000;
    engine.evaluateTask(perfect('task-A', 'agent-y'));
    now = 3000;
    engine.evaluateTask(perfect('task-B', 'agent-x'));

    assert.deepEqual(
      engine.byTask('task-A').map((r) => r.evaluationId),
      engine.byTask('task-A').map((r) => r.evaluationId),
    );
    assert.equal(engine.byTask('task-A').length, 2);
    assert.equal(engine.byTask('task-A')[0].evaluatedAt, 1000);
    assert.equal(engine.byTask('task-A')[1].evaluatedAt, 2000);
    assert.equal(engine.byAgent('agent-x').length, 2);
    assert.equal(engine.byAgent('agent-x')[0].taskId, 'task-A');
  });

  it('generates unique evaluation ids', () => {
    const engine = new EvaluationEngine();
    const ids = new Set(
      Array.from({ length: 50 }, (_, i) => engine.evaluateTask(perfect(`t-${i}`)).evaluationId),
    );
    assert.equal(ids.size, 50);
  });

  it('returns undefined for unknown evaluation ids', () => {
    const engine = new EvaluationEngine();
    assert.equal(engine.get('eval_nope'), undefined);
  });
});
