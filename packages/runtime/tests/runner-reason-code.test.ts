/**
 * Batch 38 — runAgent carries the machine-readable FactoryError.code
 * through to RunResult.reasonCode, so the server can classify §81
 * needsHuman emissions determinately (BUDGET_EXCEEDED → 'budget-exceeded',
 * LOOP_STAGNATION → 'repeated-failure') instead of matching on the
 * human-readable reason message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  AgentLoop,
  BudgetExceeded,
  Harness,
  StubAdapter,
  runAgent,
} from '../src/index';

function makeAgent(): Agent {
  return {
    id: 'agent-coder-1', name: 'Cody', displayName: 'Cody', jobTitle: 'AI Coder',
    department: 'engineering', parentAgentId: null, mission: 'Write correct code.',
    instructions: 'Follow the loop.', skills: ['typescript'], rules: [],
    model: 'code-coder', reasoningLevel: 'MEDIUM', tools: ['read', 'write'],
    permissions: ['filesystem.read', 'filesystem.write'], autonomyLevel: 3,
    status: 'WORKING', version: 1,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  };
}

function makeTask(): Task {
  return {
    id: 'task-1', projectId: 'proj-1', parentTaskId: null,
    title: 'Fix the failing unit test', goal: 'Make the unit suite green.',
    description: '', priority: 'P2', severity: 'MAJOR',
    acceptanceCriteria: ['unit tests pass'], constraints: [],
    workspace: '/tmp/ai-factory-ws', creator: 'tan', status: 'IN_PROGRESS',
    currentAgentId: 'agent-coder-1', assignedAgentIds: ['agent-coder-1'],
    subtaskIds: [], dependencies: [], risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    completedAt: null,
  };
}

function makeHarness(permissions: Permission[] = ['filesystem.read', 'filesystem.write']) {
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions,
    evidence: { collect: () => undefined },
  });
}

describe('runAgent reasonCode bridge (Batch 38)', () => {
  it('BudgetExceeded escaping the loop → outcome failed + reasonCode BUDGET_EXCEEDED', async () => {
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      stepFn: () => {
        throw new BudgetExceeded('test budget');
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reasonCode, 'BUDGET_EXCEEDED');
    assert.match(result.reason ?? '', /Budget exceeded/);
  });

  it('same error 3 times → LoopStagnation → outcome escalated + reasonCode LOOP_STAGNATION', async () => {
    const loop = new AgentLoop({
      budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 },
      stagnationLimit: 3,
    });
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      loop,
      stepFn: () => {
        throw new Error('same boom');
      },
    });
    assert.equal(result.outcome, 'escalated');
    assert.equal(result.reasonCode, 'LOOP_STAGNATION');
    assert.match(result.reason ?? '', /Loop stagnated/);
  });

  it('a plain non-FactoryError escaping the loop → outcome failed + reasonCode null (no false §81 signal)', async () => {
    class PlainThrowLoop extends AgentLoop {
      override async run(): Promise<never> {
        throw new Error('plain boom');
      }
    }
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      loop: new PlainThrowLoop({
        budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 },
      }),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reasonCode, null);
    assert.match(result.reason ?? '', /plain boom/);
  });

  it('a clean run → reasonCode null', async () => {
    const adapter = new StubAdapter([{ text: 'done', toolCalls: [] }]);
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.reasonCode ?? null, null);
  });
});
