/**
 * Pre-send prompt secret scanning — INV-26 / §46.2.
 *
 * "A prompt that contains a secret has already leaked even if the log is
 * redacted afterwards, so the input is checked BEFORE sending." The default
 * StepFn's ACT phase scans the assembled prompt with scanForSecrets
 * (from @ai-factory/memory) before any model-call budget is consumed and
 * before adapter.invoke is called: a detected secret never leaves the
 * process, and the run fails closed (escalates via stagnation — the prompt
 * is deterministic, so retries cannot clear the signature).
 *
 * Run: node --test dist/tests/runner-secret-scan.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import type {
  AdapterInput,
  AdapterOutput,
  RuntimeAdapter,
} from '../src/index';
import { Harness, runAgent } from '../src/index';

/** Adapter that counts invocations so the test can prove "never called". */
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

function makeTask(goal: string): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    parentTaskId: null,
    title: 'Fix the failing unit test',
    goal,
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

describe('pre-send prompt secret scan (INV-26 / §46.2)', () => {
  it('blocks the adapter invoke when the prompt contains a suspected raw secret', async () => {
    const adapter = new CountingAdapter();
    const secretValue = 'abcdefghijklmnop1234';
    const result = await runAgent({
      agent: makeAgent(),
      // token-assignment pattern: token = "<16+ chars>"
      task: makeTask(`Rotate the leaked key; config has token = "${secretValue}"`),
      harness: makeHarness(),
      adapter,
      tools: {},
    });

    // Fail-closed: the adapter was never invoked — the secret never left
    // the process.
    assert.equal(adapter.calls, 0, 'adapter.invoke must never be called with a secret in the prompt');
    // The prompt is deterministic, so the same signature repeats 3 times and
    // the run escalates via stagnation instead of silently retrying.
    assert.equal(result.outcome, 'escalated');
    assert.match(result.reason ?? '', /stagnat/);
    assert.ok(
      result.trace.some((t) => t.phase === 'ACT' && /secret-in-prompt/.test(t.result)),
      'stagnation must name the secret-in-prompt signature',
    );
    // The pre-send path itself must never echo the secret value: the scan
    // error names only the matched pattern, never the value. (Honest
    // boundary: the run trace still records the user's own task text
    // verbatim in the UNDERSTAND phase — that is pre-existing user-input
    // logging, a separate concern from the adapter send path, flagged as
    // follow-up in the batch report.)
    const actEntries = result.trace.filter((t) => t.phase === 'ACT');
    assert.ok(actEntries.length > 0, 'ACT failures must be in the trace');
    for (const e of actEntries) {
      assert.ok(!e.result.includes(secretValue), 'ACT failure must not echo the secret value');
      assert.ok(!(e.action ?? '').includes(secretValue), 'ACT note must not echo the secret value');
    }
    assert.ok(
      !(result.reason ?? '').includes(secretValue),
      'the escalation reason must not echo the secret value',
    );
  });

  it('lets a clean prompt through to the adapter', async () => {
    const adapter = new CountingAdapter();
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask('Make the unit suite green.'),
      harness: makeHarness(),
      adapter,
      tools: {},
    });

    assert.ok(adapter.calls > 0, 'adapter.invoke must be called for a clean prompt');
    assert.equal(result.outcome, 'completed');
  });
});
