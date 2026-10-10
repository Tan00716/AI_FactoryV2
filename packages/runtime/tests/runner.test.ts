/**
 * Tests for runAgent + adapters — spec §24–§27 integration.
 * Run: node --test dist/tests/runner.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  AdapterNotImplemented,
  AgentLoop,
  BudgetExceeded,
  CodexAdapter,
  Harness,
  LoopStagnation,
  StubAdapter,
  runAgent,
} from '../src/index';

function makeAgent(): Agent {
  return {
    id: 'agent-coder-1',
    name: 'Cody',
    displayName: 'Cody the Coder',
    jobTitle: 'AI Coder',
    department: 'engineering',
    parentAgentId: null,
    mission: 'Write correct, tested code.',
    instructions: 'Follow the loop.',
    skills: ['typescript'],
    rules: [],
    model: 'code-coder',
    reasoningLevel: 'MEDIUM',
    tools: ['read', 'write'],
    permissions: ['filesystem.read', 'filesystem.write'],
    autonomyLevel: 3,
    status: 'WORKING',
    version: 1,
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
  };
}

function makeTask(): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    parentTaskId: null,
    title: 'Fix the failing unit test',
    goal: 'Make the unit suite green.',
    description: '',
    priority: 'P2',
    severity: 'MAJOR',
    acceptanceCriteria: ['unit tests pass'],
    constraints: [],
    workspace: '/tmp/ai-factory-ws',
    creator: 'tan',
    status: 'IN_PROGRESS',
    currentAgentId: 'agent-coder-1',
    assignedAgentIds: ['agent-coder-1'],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
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

function codingRouteRequest() {
  return {
    taskType: 'coding' as const,
    complexity: 4 as const,
    requiredTools: [] as string[],
    latencyPref: 'low' as const,
    costPref: 'high' as const,
    privacy: 'internal' as const,
    needsReasoning: true,
    contextNeeded: 'large' as const,
    needsVision: false,
    currentUsage: { usedPct: 12 },
  };
}

describe('runAgent with StubAdapter (§27)', () => {
  it('runs to completion, routing the model and executing adapter tool calls', async () => {
    const adapter = new StubAdapter([
      { text: 'fix applied', toolCalls: [{ tool: 'write', args: { path: 'fix.ts' } }] },
    ]);
    const harness = makeHarness();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter,
      routeRequest: codingRouteRequest(),
      tools: { write: async () => 'written' },
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(result.steps, 6);
    assert.deepEqual(result.handoffs, []);

    const routing = result.evidence.find((e) => e.type === 'model_routing');
    assert.ok(routing, 'model routing decision must be recorded as evidence');
    assert.equal(routing?.payload['primary'], 'code-coder');

    assert.ok(result.evidence.some((e) => e.type === 'tool_result'));
    assert.ok(result.trace.some((t) => t.phase === 'RUNNER' && t.action === 'run start'));
    assert.ok(result.trace.some((t) => t.phase === 'EVALUATE'));
  });

  it('escalates when the harness denies a tool 3 times (stagnation → auto-escalate)', async () => {
    const scripted = Array.from({ length: 5 }, () => ({
      text: 'try shell',
      toolCalls: [{ tool: 'shell', args: { cmd: 'ls' } }],
    }));
    const adapter = new StubAdapter(scripted);
    // No 'shell.execute' permission → every ACT fails with the same signature.
    const harness = makeHarness(['filesystem.read']);
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter,
      tools: { shell: async () => 'listed' },
    });
    assert.equal(result.outcome, 'escalated');
    assert.match(result.reason ?? '', /stagnated/);
  });
});

describe('runAgent with a scripted StepFn', () => {
  it('shows RETRY: failing test twice, then passing (§25 example)', async () => {
    let testRuns = 0;
    const harness = makeHarness();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter: new StubAdapter([]),
      stepFn: (phase) => {
        switch (phase) {
          case 'ACT':
            testRuns += 1;
            return { ok: true, note: `test run #${testRuns}` };
          case 'VERIFY':
            return testRuns < 3
              ? { ok: false, error: '2 tests failed', errorSignature: 'unit:2-failed' }
              : { ok: true, note: 'all green' };
          case 'EVALUATE':
            return { ok: true, decision: 'COMPLETE' };
          default:
            return { ok: true };
        }
      },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.steps, 16);
    assert.match(result.reason ?? '', /COMPLETE/);
  });

  it('escalates on stagnation: same error 3 times (§25)', async () => {
    const harness = makeHarness();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter: new StubAdapter([]),
      stepFn: () => ({ ok: false, error: 'same old failure', errorSignature: 'unit:2-failed' }),
    });
    assert.equal(result.outcome, 'escalated');
    assert.match(result.reason ?? '', /stagnated/);
  });

  it('records HANDOFF targets', async () => {
    const harness = makeHarness();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter: new StubAdapter([]),
      stepFn: (phase) =>
        phase === 'EVALUATE'
          ? { ok: true, decision: 'HANDOFF', handoffTo: 'qa-lead' }
          : { ok: true },
    });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.handoffs, ['qa-lead']);
  });

  it('fails the run when budgets are exceeded', async () => {
    const harness = makeHarness();
    const loop = new AgentLoop({
      budgets: { maxSteps: 2, timeMs: 60_000, maxRetries: 100 },
    });
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter: new StubAdapter([]),
      loop,
      stepFn: () => ({ ok: true, decision: 'CONTINUE' }),
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /Budget exceeded/);
    assert.ok(result.steps >= 2);
  });
});

describe('adapters (§27)', () => {
  it('StubAdapter replays scripted responses in order', async () => {
    const adapter = new StubAdapter([
      { text: 'first', toolCalls: [{ tool: 'read', args: {} }] },
      { text: 'second', toolCalls: [] },
    ]);
    const first = await adapter.invoke({ prompt: 'p', tools: ['read'] });
    assert.equal(first.text, 'first');
    assert.equal(first.toolCalls.length, 1);
    const second = await adapter.invoke({ prompt: 'p', tools: [] });
    assert.equal(second.text, 'second');
    const exhausted = await adapter.invoke({ prompt: 'p', tools: [] });
    assert.deepEqual(exhausted, { text: '', toolCalls: [] });
  });

  it('CodexAdapter.invoke throws a clear AdapterNotImplemented (§28)', async () => {
    const adapter = new CodexAdapter({ auth: 'chatgpt-oauth', appServerUrl: 'http://127.0.0.1:18791' });
    assert.equal(adapter.name, 'codex');
    assert.equal(adapter.authKind, 'chatgpt-oauth');
    await assert.rejects(
      adapter.invoke({ prompt: 'x', tools: [] }),
      (err: unknown) =>
        err instanceof AdapterNotImplemented &&
        /Codex app-server/.test(err.message) &&
        /chatgpt-oauth/.test(err.message),
    );
  });

  it('a failing CodexAdapter surfaces through the loop (sanity)', async () => {
    const err = await new CodexAdapter({ auth: 'api-key' })
      .invoke({ prompt: 'x', tools: [] })
      .catch((e: unknown) => e);
    assert.ok(err instanceof AdapterNotImplemented);
    assert.ok(!(err instanceof LoopStagnation));
    assert.ok(!(err instanceof BudgetExceeded));
  });
});
