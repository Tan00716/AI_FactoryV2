/**
 * Tests for agent-profile aggregation (spec §57): incremental updates across
 * many evaluations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentProfiler,
  EvaluationEngine,
  EvaluationResult,
  isFirstPass,
  updateProfile,
} from '../src/index';

let now = 1_000;
function engine(): EvaluationEngine {
  return new EvaluationEngine({ now: () => now });
}

function evalFor(
  eng: EvaluationEngine,
  taskId: string,
  overrides: Partial<Parameters<EvaluationEngine['evaluateTask']>[0]> = {},
): EvaluationResult {
  return eng.evaluateTask({
    taskId,
    agentId: 'backend-01',
    summary: 'x',
    evidenceIds: ['ev-1'],
    success: true,
    tests: { passed: 10, total: 10 },
    regressions: 0,
    reviewRounds: 1,
    reviewRejections: 0,
    fixLoops: 0,
    durationMs: 1000,
    tokensUsed: 1000,
    toolCalls: 10,
    toolErrors: 0,
    completionClaims: 1,
    falseCompletions: 0,
    deployments: 0,
    rollbacks: 0,
    decisions: 1,
    escalations: 0,
    ...overrides,
  });
}

describe('updateProfile', () => {
  it('creates a profile from the first evaluation', () => {
    const eng = engine();
    const r = evalFor(eng, 't1');
    const p = updateProfile(r);
    assert.equal(p.agentId, 'backend-01');
    assert.equal(p.evaluations, 1);
    assert.equal(p.successRate, 1);
    assert.equal(p.firstPassQaRate, 1);
    assert.equal(p.reviewRejectionRate, 0);
    assert.equal(p.avgRepairLoops, 0);
    assert.equal(p.falseCompletionRate, 0);
    assert.equal(p.lastEvaluatedAt, r.evaluatedAt);
  });

  it('aggregates incrementally across evaluations', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    profiler.record(evalFor(eng, 't1')); // success, first pass
    const p2 = profiler.record(
      evalFor(eng, 't2', { success: false, fixLoops: 3, reviewRejections: 1, reviewRounds: 2 }),
    );
    assert.equal(p2.evaluations, 2);
    assert.equal(p2.successRate, 0.5);
    assert.equal(p2.firstPassQaRate, 0.5);
    assert.equal(p2.reviewRejectionRate, 0.25); // (0 + 0.5) / 2
    assert.equal(p2.avgRepairLoops, 1.5); // (0 + 3) / 2
  });

  it('excludes reworked tasks from first-pass QA rate', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    profiler.record(evalFor(eng, 't1', { fixLoops: 2 })); // success but reworked
    const p = profiler.record(evalFor(eng, 't2')); // first pass
    assert.equal(p.firstPassQaRate, 0.5);
  });

  it('averages false-completion rates', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    profiler.record(evalFor(eng, 't1'));
    const p = profiler.record(
      evalFor(eng, 't2', { completionClaims: 4, falseCompletions: 2 }),
    );
    assert.equal(p.falseCompletionRate, 0.25); // (0 + 0.5) / 2
  });

  it('updates lastEvaluatedAt on every record', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    now = 1000;
    profiler.record(evalFor(eng, 't1'));
    now = 9000;
    const p = profiler.record(evalFor(eng, 't2'));
    assert.equal(p.lastEvaluatedAt, 9000);
  });
});

describe('AgentProfiler', () => {
  it('returns undefined for an agent with no evaluations', () => {
    assert.equal(new AgentProfiler().get('ghost'), undefined);
  });

  it('keeps profiles separate per agent', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    profiler.record(evalFor(eng, 't1', { agentId: 'a1' }));
    profiler.record(evalFor(eng, 't2', { agentId: 'a2', success: false }));
    assert.equal(profiler.get('a1')!.successRate, 1);
    assert.equal(profiler.get('a2')!.successRate, 0);
    assert.equal(profiler.all().length, 2);
  });

  it('ranks agents by success rate in the leaderboard', () => {
    const eng = engine();
    const profiler = new AgentProfiler();
    profiler.record(evalFor(eng, 't1', { agentId: 'a1', success: false }));
    profiler.record(evalFor(eng, 't2', { agentId: 'a2' }));
    const board = profiler.leaderboard();
    assert.equal(board[0].agentId, 'a2');
    assert.equal(board[1].agentId, 'a1');
  });

  it('isFirstPass is false for failed or reworked tasks', () => {
    const eng = engine();
    assert.equal(isFirstPass(evalFor(eng, 't1')), true);
    assert.equal(isFirstPass(evalFor(eng, 't2', { fixLoops: 1 })), false);
    assert.equal(isFirstPass(evalFor(eng, 't3', { success: false })), false);
  });
});
