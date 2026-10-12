/**
 * Batch 5 — §28.1 G-53: StepIntent wiring on the runAgent default path.
 *
 * Before this batch the StepIntentStore existed and Harness.runTool would
 * persist an intent BEFORE executing a tool — but no production path ever
 * supplied a store (runner/loop/server all passed nothing), so intents
 * were never recorded in a real run. runAgent now creates/attaches one
 * store per run (priority mirrors the BudgetTracker rule: harness's own
 * store > options.intentStore > fresh default) and reports an
 * intentSummary on the RunResult.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  Harness,
  StepIntentStore,
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

function makeHarness(extra: Partial<HarnessOptions> = {}) {
  const permissions: Permission[] = ['filesystem.read', 'filesystem.write'];
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions,
    evidence: { collect: () => undefined },
    ...extra,
  });
}

const oneWriteCall = () =>
  new StubAdapter([
    { text: 'done', toolCalls: [{ tool: 'write', args: { path: 'fix.ts' } }] },
  ]);

describe('runAgent default path records step intents (§28.1 G-53)', () => {
  it('no store supplied anywhere: run still records the intent and reports a summary', async () => {
    const harness = makeHarness(); // constructed WITHOUT an intentStore
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness, adapter: oneWriteCall(),
      tools: { write: async () => 'written' },
    });
    assert.equal(result.outcome, 'completed');
    // The summary proves an intent was persisted for this run's tool step.
    assert.equal(result.intentSummary?.count, 1);
    assert.equal(result.intentSummary?.executed, 1);
    assert.equal(result.intentSummary?.failed, 0);
    assert.equal(result.intentSummary?.pending, 0);
    assert.equal(result.intentSummary?.intentIds.length, 1);
    // And the store runAgent attached to the harness really holds it.
    const store = harness.intentStore;
    assert.ok(store, 'runAgent must attach a default StepIntentStore');
    const intents = store.listIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0].id, result.intentSummary?.intentIds[0]);
    assert.equal(intents[0].tool, 'write');
    assert.equal(intents[0].status, 'EXECUTED');
  });

  it('an explicitly injected options.intentStore is the store actually written to', async () => {
    const store = new StepIntentStore();
    const harness = makeHarness({ runId: 'run-b53-explicit' });
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness, adapter: oneWriteCall(),
      tools: { write: async () => 'written' },
      intentStore: store,
    });
    assert.equal(result.outcome, 'completed');
    const intents = store.listIntents('run-b53-explicit');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].tool, 'write');
    assert.equal(intents[0].status, 'EXECUTED');
    assert.equal(result.intentSummary?.intentIds[0], intents[0].id);
  });

  it("the harness's own store wins over options.intentStore (never overridden, never double-written)", async () => {
    const harnessStore = new StepIntentStore();
    const optionsStore = new StepIntentStore();
    const harness = makeHarness({ runId: 'run-b53-harness', intentStore: harnessStore });
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness, adapter: oneWriteCall(),
      tools: { write: async () => 'written' },
      intentStore: optionsStore,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(harness.intentStore, harnessStore);
    assert.equal(harnessStore.listIntents('run-b53-harness').length, 1);
    assert.equal(optionsStore.listIntents().length, 0);
    // The summary is read from the effective (harness) store.
    assert.equal(result.intentSummary?.count, 1);
    assert.equal(
      result.intentSummary?.intentIds[0],
      harnessStore.listIntents('run-b53-harness')[0].id,
    );
  });

  it('a failed tool execution commits its intent as FAILED', async () => {
    const store = new StepIntentStore();
    const harness = makeHarness({ runId: 'run-b53-fail' });
    const result = await runAgent({
      agent: makeAgent(), task: makeTask(), harness, adapter: oneWriteCall(),
      tools: {
        write: async () => {
          throw new Error('disk exploded');
        },
      },
      intentStore: store,
    });
    const intents = store.listIntents('run-b53-fail');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'FAILED');
    assert.equal(result.intentSummary?.count, 1);
    assert.equal(result.intentSummary?.failed, 1);
    assert.equal(result.intentSummary?.executed, 0);
  });
});
