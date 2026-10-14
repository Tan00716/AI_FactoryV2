/**
 * Batch 40 — deterministic environment-failure signals.
 *
 * The first half of the 39-4 precondition for ever wiring §81
 * 'irrecoverable-env-error': environment failures get machine-readable
 * FactoryError codes that flow through the Batch-38 RunResult.reasonCode
 * bridge, instead of being guessed by the heuristic classifier.
 *
 * Signal layer ONLY: nothing in this batch auto-emits needsHuman on
 * these codes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  AgentLoop,
  Harness,
  isEnvErrorCode,
  MissingBinaryError,
  runAgent,
  runCommandPipe,
  SandboxUnavailableError,
  StubAdapter,
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

describe('environment error codes → RunResult.reasonCode (Batch 40)', () => {
  class EnvThrowLoop extends AgentLoop {
    constructor(private readonly err: Error) {
      super({ budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 } });
    }
    override async run(): Promise<never> {
      throw this.err;
    }
  }

  it('SandboxUnavailableError escaping the loop → outcome failed + reasonCode ENV_SANDBOX_UNAVAILABLE (no auto-escalation)', async () => {
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      loop: new EnvThrowLoop(new SandboxUnavailableError('bwrap probe failed to spawn: ENOENT')),
    });
    // Environment failure is a failure, not a stagnation — the run fails
    // with the machine-readable code; nothing here emits needsHuman.
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reasonCode, 'ENV_SANDBOX_UNAVAILABLE');
    assert.match(result.reason ?? '', /Sandbox unavailable/);
  });

  it('MissingBinaryError escaping the loop → outcome failed + reasonCode ENV_BINARY_MISSING', async () => {
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      loop: new EnvThrowLoop(new MissingBinaryError('bwrap')),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reasonCode, 'ENV_BINARY_MISSING');
    assert.match(result.reason ?? '', /Required binary 'bwrap' is missing/);
  });

  it('a PERSISTENT env error (same code every step) → LoopStagnation → escalated + reasonCode LOOP_STAGNATION', async () => {
    // Honest consequence, pinned: an env failure that repeats with no new
    // evidence is stagnation, and stagnation is the designed escalation
    // path (38-4 wires LOOP_STAGNATION → 'repeated-failure'). The terminal
    // error is the stagnation, so its code — not the env code — is the
    // reasonCode. No env code is invented or masked.
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
        throw new SandboxUnavailableError('bwrap probe failed to spawn: ENOENT');
      },
    });
    assert.equal(result.outcome, 'escalated');
    assert.equal(result.reasonCode, 'LOOP_STAGNATION');
  });

  it('a plain non-FactoryError escaping the loop → reasonCode null (no false env signal)', async () => {
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
  });

  it('runCommandPipe on a missing binary throws MissingBinaryError with the code (deterministic OS signal)', async () => {
    await assert.rejects(
      () => runCommandPipe(['/nonexistent/ai-factory-bin-xyz-40', '--version'], { timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof MissingBinaryError);
        assert.equal((err as MissingBinaryError).code, 'ENV_BINARY_MISSING');
        assert.equal((err as MissingBinaryError).binary, '/nonexistent/ai-factory-bin-xyz-40');
        return true;
      },
    );
  });

  it('runCommandPipe on a present binary still works (no regression)', async () => {
    const r = await runCommandPipe([process.execPath, '-e', 'process.exit(0)'], { timeoutMs: 10000 });
    assert.equal(r.exitCode, 0);
  });

  it('runCommandPipe on a failing (but present) binary does not raise an env code', async () => {
    const r = await runCommandPipe([process.execPath, '-e', 'process.exit(3)'], { timeoutMs: 10000 });
    assert.equal(r.exitCode, 3);
  });
});

describe('stagnation signature → §81 irrecoverable-env-error signal (Batch 43)', () => {
  it('persistent ENV_BINARY_MISSING → escalated + LOOP_STAGNATION + stagnationSignature ENV_BINARY_MISSING', async () => {
    // True path: the loop retries the same env-erroring step to the
    // stagnation limit with no progress — the loop's own recovery is
    // exhausted, which is exactly what "irrecoverable" means here.
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
        throw new MissingBinaryError('bwrap');
      },
    });
    assert.equal(result.outcome, 'escalated');
    assert.equal(result.reasonCode, 'LOOP_STAGNATION');
    assert.equal(result.stagnationSignature, 'ENV_BINARY_MISSING');
  });

  it('persistent non-env error → stagnationSignature carries the non-env signature (no env signal invented)', async () => {
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
        throw new Error('plain repeated boom');
      },
    });
    assert.equal(result.outcome, 'escalated');
    assert.equal(result.reasonCode, 'LOOP_STAGNATION');
    assert.equal(result.stagnationSignature, 'step-throw');
    assert.equal(isEnvErrorCode(result.stagnationSignature), false);
  });

  it('non-stagnation terminal states carry no stagnationSignature', async () => {
    class EnvThrowLoop extends AgentLoop {
      constructor(private readonly err: Error) {
        super({ budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 } });
      }
      override async run(): Promise<never> {
        throw this.err;
      }
    }
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(),
      adapter: new StubAdapter([]),
      loop: new EnvThrowLoop(new SandboxUnavailableError('bwrap probe failed: ENOENT')),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reasonCode, 'ENV_SANDBOX_UNAVAILABLE');
    assert.equal(result.stagnationSignature, undefined);
  });

  it('isEnvErrorCode: exact set membership — no prefix accidents, no message sniffing', () => {
    assert.equal(isEnvErrorCode('ENV_BINARY_MISSING'), true);
    assert.equal(isEnvErrorCode('ENV_SANDBOX_UNAVAILABLE'), true);
    // Not in the set: close-but-unknown names, non-env codes, junk.
    assert.equal(isEnvErrorCode('ENV_DISK_FULL'), false);
    assert.equal(isEnvErrorCode('ENV_'), false);
    assert.equal(isEnvErrorCode('LOOP_STAGNATION'), false);
    assert.equal(isEnvErrorCode('BUDGET_EXCEEDED'), false);
    assert.equal(isEnvErrorCode('step-throw'), false);
    assert.equal(isEnvErrorCode(null), false);
    assert.equal(isEnvErrorCode(undefined), false);
    assert.equal(isEnvErrorCode(''), false);
    // A message *mentioning* an env code is not a code.
    assert.equal(isEnvErrorCode('Sandbox unavailable: ENV_BINARY_MISSING?'), false);
  });
});
