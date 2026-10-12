/**
 * Batch 2 — §25 G-51/G-52: extended budgets actually enforced on the real
 * execution path (runAgent default path + Harness.runTool), the
 * permission no-bypass guard wired into tool retries, and jittered retry
 * bounded by BOTH maxAttempts and a total budget.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  BudgetExceeded,
  BudgetTracker,
  Harness,
  PermissionDenied,
  StubAdapter,
  runAgent,
  type HarnessOptions,
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

describe('runAgent default path enforces all extended budgets (§25 G-51)', () => {
  it('a successful run reports budget usage (model + tool calls consumed)', async () => {
    const adapter = new StubAdapter([
      { text: 'done', toolCalls: [{ tool: 'write', args: { path: 'fix.ts' } }] },
    ]);
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(), adapter,
      tools: { write: async () => 'written' },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.budgetUsage?.modelCalls, 1);
    assert.equal(result.budgetUsage?.toolCalls, 1);
  });

  it('maxModelCalls (previously unexecuted) fails the run explicitly', async () => {
    const adapter = new StubAdapter([{ text: 'x', toolCalls: [] }]);
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(), adapter,
      extendedBudgets: { maxModelCalls: 0 },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /model calls 1 > 0/);
    assert.equal(result.budgetUsage?.modelCalls, 1);
  });

  it('maxToolCalls (previously unexecuted) fails the run explicitly', async () => {
    const adapter = new StubAdapter([
      { text: 'x', toolCalls: [{ tool: 'write', args: {} }] },
    ]);
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(), adapter,
      tools: { write: async () => 'written' },
      extendedBudgets: { maxToolCalls: 0 },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /tool calls 1 > 0/);
    assert.equal(result.budgetUsage?.toolCalls, 1);
  });

  it('maxContextChars (previously unexecuted) fails the run at OBSERVE', async () => {
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(),
      adapter: new StubAdapter([]),
      extendedBudgets: { maxContextChars: 10 },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /context \d+ chars > 10/);
  });

  it('maxRepairLoops (previously unexecuted) caps failure-driven restarts', async () => {
    let failures = 0;
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(),
      adapter: new StubAdapter([]),
      extendedBudgets: { maxRepairLoops: 1 },
      stepFn: (phase) => {
        if (phase === 'VERIFY') {
          failures += 1;
          // distinct signature each time: stagnation must not mask the budget
          return { ok: false, error: `fail ${failures}`, errorSignature: `sig-${failures}` };
        }
        return phase === 'EVALUATE' ? { ok: true, decision: 'COMPLETE' } : { ok: true };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /repair loops 2 > 1/);
    assert.equal(result.budgetUsage?.repairLoops, 2);
  });

  it('maxNoProgressSteps (previously unexecuted) gives up on a stuck loop', async () => {
    let failures = 0;
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness: makeHarness(),
      adapter: new StubAdapter([]),
      extendedBudgets: { maxNoProgressSteps: 2 },
      stepFn: () => {
        failures += 1;
        return { ok: false, error: `stuck ${failures}`, errorSignature: `stuck-${failures}` };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /consecutive steps without progress/);
  });
});

describe('Harness.runTool retry discipline (§25 G-52)', () => {
  function retryHarness(extra: Partial<HarnessOptions>) {
    return new Harness({
      allowedRoots: ['/tmp/ai-factory-ws'],
      stepTimeoutMs: 2000,
      permissions: ['filesystem.read'],
      evidence: { collect: () => undefined },
      ...extra,
    });
  }

  it('retries transient failures with jitter and succeeds; each attempt consumes a tool call', async () => {
    const tracker = new BudgetTracker({ maxToolCalls: 10 });
    let attempts = 0;
    const harness = retryHarness({
      budgetTracker: tracker,
      toolRetryPolicy: { maxAttempts: 4, baseMs: 100, capMs: 1_000, totalBudgetMs: 60_000 },
      retryRand: () => 0,
      retrySleep: async () => {},
    });
    const out = await harness.runTool('read', {}, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNRESET socket hang up');
      return 'content';
    });
    assert.equal(out, 'content');
    assert.equal(attempts, 3);
    assert.equal(tracker.usage.toolCalls, 3);
  });

  it('total budget caps retries before maxAttempts is reached', async () => {
    let now = 0;
    let attempts = 0;
    const harness = retryHarness({
      clock: { now: () => now },
      toolRetryPolicy: { maxAttempts: 5, baseMs: 1_000, capMs: 5_000, totalBudgetMs: 1_500 },
      retryRand: () => 1, // worst-case jitter wait
      retrySleep: async (ms: number) => { now += ms; },
    });
    await assert.rejects(
      harness.runTool('read', {}, async () => {
        attempts += 1;
        throw new Error('ECONNRESET socket hang up');
      }),
      BudgetExceeded,
    );
    // attempt 1: wait 1000 (0+1000 ≤ 1500) → attempt 2: wait 2000 would
    // exceed the 1500 total budget → BudgetExceeded, attempts stop at 2 < 5.
    assert.equal(attempts, 2);
  });

  it('tool-call budget is enforced inside retries (no silent extra attempts)', async () => {
    const tracker = new BudgetTracker({ maxToolCalls: 1 });
    let attempts = 0;
    const harness = retryHarness({
      budgetTracker: tracker,
      toolRetryPolicy: { maxAttempts: 5, baseMs: 10, capMs: 100, totalBudgetMs: 60_000 },
      retryRand: () => 0,
      retrySleep: async () => {},
    });
    await assert.rejects(
      harness.runTool('read', {}, async () => {
        attempts += 1;
        throw new Error('ECONNRESET socket hang up');
      }),
      BudgetExceeded,
    );
    assert.equal(attempts, 1); // second attempt died at consumeToolCall
  });

  it('retrying after a permission denial trips the no-bypass guard', async () => {
    let attempts = 0;
    const harness = retryHarness({
      toolRetryPolicy: { maxAttempts: 3, baseMs: 10, capMs: 100, totalBudgetMs: 60_000 },
      retryRand: () => 0,
      retrySleep: async () => {},
    });
    await assert.rejects(
      harness.runTool('read', {}, async () => {
        attempts += 1;
        throw new PermissionDenied('read', 'denied by policy');
      }),
      (err: unknown) => (err as { code?: string }).code === 'PERMISSION_BYPASS_ATTEMPT',
    );
    assert.equal(attempts, 1); // impl ran once; the guard stopped the retry
  });

  it('non-retryable failures are not retried (no lucky-pass fishing)', async () => {
    let attempts = 0;
    const harness = retryHarness({
      toolRetryPolicy: { maxAttempts: 4, baseMs: 10, capMs: 100, totalBudgetMs: 60_000 },
      retryRand: () => 0,
      retrySleep: async () => {},
    });
    await assert.rejects(
      harness.runTool('read', {}, async () => {
        attempts += 1;
        throw new Error('plain deterministic failure');
      }),
      /deterministic failure/,
    );
    assert.equal(attempts, 1);
  });
});
