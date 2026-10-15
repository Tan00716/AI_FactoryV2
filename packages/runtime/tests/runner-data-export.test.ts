/**
 * Cloud model calls as controlled data-export events — INV-30 / §26.
 *
 * "Local-first 不等于代码从不离开电脑；发送给云模型属于受控数据外发。"
 * The default StepFn's ACT phase records an explicit DATA_EXPORT evidence
 * event BEFORE adapter.invoke whenever the routed provider is not local:
 * provider + model + the privacy class the route request was filed under
 * (§26.3). Local providers are exempt (data never leaves the machine);
 * an unknown provider fails safe to "export" (recorded), never silently
 * assumed local. Routing still enforces the privacy dimension itself
 * (sensitive data is refused non-local candidates — see
 * model-router-route.test.ts); this event is the audit side: a cloud
 * call is never just an implicit routing outcome.
 *
 * Run: node --test dist/tests/runner-data-export.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import type { RouteRequest } from '@ai-factory/model-router';
import type {
  AdapterInput,
  AdapterOutput,
  RuntimeAdapter,
} from '../src/index';
import { dataExportEventFor, Harness, runAgent } from '../src/index';

/** Adapter that counts invocations so the test can prove "called exactly once". */
class CountingAdapter implements RuntimeAdapter {
  readonly name = 'counting-stub';
  calls = 0;
  async invoke(_input: AdapterInput): Promise<AdapterOutput> {
    this.calls += 1;
    return { text: 'done', toolCalls: [] };
  }
}

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
    tools: [],
    permissions: ['filesystem.read'],
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
    title: 'Refactor the parser',
    goal: 'Refactor the parser for readability',
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

function makeHarness(permissions: Permission[] = ['filesystem.read']) {
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions,
    evidence: { collect: () => undefined },
  });
}

function baseRouteRequest(over: Partial<RouteRequest>): RouteRequest {
  return {
    taskType: 'coding',
    complexity: 4,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'low',
    privacy: 'public',
    needsReasoning: true,
    contextNeeded: 'large',
    needsVision: false,
    currentUsage: { usedPct: 10 },
    ...over,
  } as RouteRequest;
}

describe('dataExportEventFor (INV-30 pure gate)', () => {
  it('returns null for a local provider — exempt, data never leaves the machine', () => {
    const ev = dataExportEventFor({
      provider: 'local',
      model: 'local-private',
      privacy: 'sensitive',
      agentId: 'a1',
      taskId: 't1',
    });
    assert.equal(ev, null);
  });

  it('builds an explicit DATA_EXPORT event for a cloud provider', () => {
    const ev = dataExportEventFor({
      provider: 'shared',
      model: 'code-coder',
      privacy: 'public',
      agentId: 'a1',
      taskId: 't1',
    });
    assert.ok(ev);
    assert.equal(ev.type, 'data_export');
    assert.equal(ev.payload['event'], 'DATA_EXPORT');
    assert.equal(ev.payload['provider'], 'shared');
    assert.equal(ev.payload['model'], 'code-coder');
    assert.equal(ev.payload['privacy'], 'public');
    assert.equal(ev.payload['agentId'], 'a1');
    assert.equal(ev.payload['taskId'], 't1');
  });

  it('fails safe on an unknown provider — recorded, never silently assumed local', () => {
    const ev = dataExportEventFor({
      provider: undefined,
      model: 'mystery',
      privacy: 'internal',
      agentId: 'a1',
      taskId: 't1',
    });
    assert.ok(ev, 'unknown provider must produce an export event');
    assert.equal(ev.payload['provider'], 'unknown');
  });
});

describe('runAgent ACT records the export event before adapter.invoke (INV-30)', () => {
  it('cloud-routed call: adapter invoked AND a DATA_EXPORT event is in the run evidence', async () => {
    const adapter = new CountingAdapter();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter,
      tools: {},
      // Empirically routes to shared:code-coder with the default catalog.
      routeRequest: baseRouteRequest({ privacy: 'public' }),
    });

    assert.equal(adapter.calls, 1, 'the adapter must still be invoked exactly once');
    const exports = result.evidence.filter((e) => e.type === 'data_export');
    assert.equal(exports.length, 1, 'exactly one data-export event per run');
    assert.equal(exports[0].payload['event'], 'DATA_EXPORT');
    assert.equal(exports[0].payload['provider'], 'shared');
    assert.equal(exports[0].payload['privacy'], 'public');
    assert.equal(exports[0].payload['agentId'], 'agent-coder-1');
    assert.equal(exports[0].payload['taskId'], 'task-1');
  });

  it('local-routed call: adapter invoked, NO data-export event', async () => {
    const adapter = new CountingAdapter();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter,
      tools: {},
      // Sensitive data is refused non-local candidates by the router
      // (§26.3, pinned in model-router-route.test.ts) — routes local.
      routeRequest: baseRouteRequest({
        privacy: 'sensitive',
        taskType: 'classification',
        complexity: 1,
        needsReasoning: false,
        contextNeeded: 'small',
      }),
    });

    assert.equal(adapter.calls, 1, 'the adapter must still be invoked exactly once');
    const exports = result.evidence.filter((e) => e.type === 'data_export');
    assert.equal(exports.length, 0, 'local providers are exempt — no export event');
  });
});
