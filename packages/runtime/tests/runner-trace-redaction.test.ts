/**
 * Trace desensitization — spec §68 / Batch 66 follow-up (a).
 *
 * G9 (Batch 63) fail-closed the *adapter send path*: a prompt containing
 * a suspected raw secret never leaves the process. But the run trace
 * still recorded the user's own task text verbatim — the UNDERSTAND
 * phase note `goal: <task.goal>` would carry `token = "..."` into
 * checkpoints and outcome().trace.
 *
 * This pins the fix: free-text credential scrubbing (redactText from
 * @ai-factory/events, spec §68) at the two trace choke points —
 * AgentLoop.recordTrace and Harness.trace — so key=value / key: value
 * pairs are masked before the step is persisted or forwarded.
 *
 * Honest boundary (documented, not pretended): raw high-entropy strings
 * WITHOUT a key prefix are not caught by redactText — the trace is
 * best-effort desensitized, and the pre-send fail-closed scan remains
 * the hard guarantee for the adapter path.
 *
 * Run: node --test dist/tests/runner-trace-redaction.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import type {
  AdapterInput,
  AdapterOutput,
  RuntimeAdapter,
} from '../src/index';
import { AgentLoop, Harness, runAgent } from '../src/index';

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

const BUDGETS = { maxSteps: 60, timeMs: 60_000, maxRetries: 20 };

describe('trace desensitization (§68 / Batch 66-a)', () => {
  it('AgentLoop.recordTrace masks key=value secrets before persisting the step', async () => {
    const seen: Array<{ action: string; result: string }> = [];
    const loop = new AgentLoop({
      budgets: BUDGETS,
      stagnationLimit: 3,
      onTrace: (step) => seen.push({ action: step.action, result: step.result }),
    });
    const secret = 'sk-live-abc123xyz';
    await loop.run(async (phase) =>
      phase === 'OBSERVE'
        ? { ok: true, note: `deployed with api_key = "${secret}"` }
        : { ok: true, decision: 'COMPLETE' as const },
    );
    assert.ok(seen.length > 0, 'onTrace must have fired');
    for (const s of seen) {
      assert.ok(!s.action.includes(secret), 'trace action must not carry the raw secret');
      assert.ok(!s.result.includes(secret), 'trace result must not carry the raw secret');
    }
    assert.ok(
      seen.some((s) => s.action.includes('***')),
      'the masked marker must be present where the secret was',
    );
  });

  it('Harness.trace masks secrets in tool-step notes', async () => {
    const seen: Array<{ action: string; result: string }> = [];
    const harness = new Harness({
      allowedRoots: ['/tmp/ai-factory-ws'],
      stepTimeoutMs: 2000,
      permissions: ['filesystem.read'],
      evidence: { collect: () => undefined },
      onTrace: (step) => seen.push({ action: step.action, result: step.result }),
    });
    const secret = 'hunter2-hunter2';
    await harness
      .runTool('read', {}, (async () => {
        throw new Error(`connection failed: password = "${secret}"`);
      }) as never)
      .catch(() => undefined);
    for (const s of seen) {
      assert.ok(!s.action.includes(secret), 'harness trace action must not carry the raw secret');
      assert.ok(!s.result.includes(secret), 'harness trace result must not carry the raw secret');
    }
  });

  it('runAgent: the UNDERSTAND goal note is desensitized end to end', async () => {
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

    // The pre-send scan still fail-closes the adapter path (unchanged).
    assert.equal(adapter.calls, 0, 'adapter.invoke must never be called with a secret in the prompt');
    assert.equal(result.outcome, 'escalated');

    // And the trace no longer carries the raw secret anywhere — the
    // UNDERSTAND goal note is masked, not verbatim.
    for (const t of result.trace) {
      assert.ok(!(t.action ?? '').includes(secretValue), `trace action must not carry the raw secret (phase ${t.phase})`);
      assert.ok(!(t.result ?? '').includes(secretValue), `trace result must not carry the raw secret (phase ${t.phase})`);
    }
    const understand = result.trace.filter((t) => t.phase === 'UNDERSTAND');
    assert.ok(understand.length > 0, 'UNDERSTAND steps must be in the trace');
    assert.ok(
      understand.some((t) => (t.action ?? '').includes('***')),
      'the UNDERSTAND goal note must show the masked marker',
    );
  });

  it('clean text passes through redaction untouched', async () => {
    const seen: Array<{ action: string }> = [];
    const loop = new AgentLoop({ budgets: BUDGETS, onTrace: (step) => seen.push({ action: step.action }) });
    await loop.run(async (phase) =>
      phase === 'OBSERVE'
        ? { ok: true, note: 'all unit tests pass, no credentials involved' }
        : { ok: true, decision: 'COMPLETE' as const },
    );
    assert.ok(
      seen.some((s) => s.action === 'all unit tests pass, no credentials involved'),
      'non-secret text must survive redaction verbatim',
    );
  });
});
