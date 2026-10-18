/**
 * W-E multimodal — runAgent threads task image attachments into the
 * prompt (as named DATA, never bytes) and into adapter.invoke() as
 * images[] descriptors.
 *
 * Run: node --test packages/runtime/dist/tests/runner-attachments.test.js
 * (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import { Harness, runAgent } from '../src/index';
import type { AdapterInput, AdapterOutput, RuntimeAdapter } from '../src/adapters';

/** Adapter that records every invoke() input it receives. */
class CapturingAdapter implements RuntimeAdapter {
  readonly name = 'capturing';
  readonly inputs: AdapterInput[] = [];
  async invoke(input: AdapterInput): Promise<AdapterOutput> {
    this.inputs.push(input);
    return { text: 'done', toolCalls: [] };
  }
}

function simpleAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Helper',
    displayName: 'Helper',
    jobTitle: 'Assistant',
    department: 'engineering',
    parentAgentId: null,
    mission: 'Help with the task.',
    instructions: 'Follow the loop.',
    skills: [],
    rules: [],
    model: 'test-model',
    reasoningLevel: 'LOW',
    tools: [],
    permissions: [],
    autonomyLevel: 1,
    status: 'WORKING',
    version: 1,
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
  };
}

function simpleTask(): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    parentTaskId: null,
    title: 'Review the screenshot',
    goal: 'Describe what the screenshot shows.',
    description: '',
    priority: 'P2',
    severity: 'MAJOR',
    acceptanceCriteria: [],
    constraints: [],
    workspace: '/tmp/ai-factory-ws',
    creator: 'human',
    status: 'IN_PROGRESS',
    currentAgentId: 'agent-1',
    assignedAgentIds: ['agent-1'],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    completedAt: null,
  };
}

function makeHarness(): Harness {
  const permissions: Permission[] = [];
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions,
    evidence: { collect: () => undefined },
  });
}

describe('runAgent image attachments (W-E)', () => {
  it('names attachments as DATA in the prompt and passes images[] to the adapter', async () => {
    const adapter = new CapturingAdapter();
    const attachments = [
      { id: 'abcdef0123456789-shot.png', filename: 'shot.png', mimeType: 'image/png' },
      { id: 'abcdef0123456789-diagram.jpg', filename: 'diagram.jpg', mimeType: 'image/jpeg' },
    ];
    const result = await runAgent({
      agent: simpleAgent(),
      task: simpleTask(),
      harness: makeHarness(),
      adapter,
      attachments,
    });
    assert.equal(result.outcome, 'completed');
    assert.ok(adapter.inputs.length > 0);
    const first = adapter.inputs[0];
    // Prompt names the images as quarantined DATA…
    assert.match(first.prompt, /Attached images \(2\)/);
    assert.match(first.prompt, /shot\.png \(image\/png\)/);
    assert.match(first.prompt, /Untrusted external content/);
    // …and the adapter receives descriptors (bytes stay server-side).
    assert.deepEqual(first.images, [
      { id: 'abcdef0123456789-shot.png', filename: 'shot.png', mimeType: 'image/png' },
      { id: 'abcdef0123456789-diagram.jpg', filename: 'diagram.jpg', mimeType: 'image/jpeg' },
    ]);
  });

  it('no attachments → no image block, images[] is empty', async () => {
    const adapter = new CapturingAdapter();
    const result = await runAgent({
      agent: simpleAgent(),
      task: simpleTask(),
      harness: makeHarness(),
      adapter,
    });
    assert.equal(result.outcome, 'completed');
    const first = adapter.inputs[0];
    assert.ok(!first.prompt.includes('Attached images'));
    assert.deepEqual(first.images, []);
  });
});
