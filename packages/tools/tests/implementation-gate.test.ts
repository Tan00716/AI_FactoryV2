/**
 * §33 implementation gate — Batch 21 (execution-surface unification).
 *
 * A tool whose implementation is not wired on this host (e.g.
 * definition-only metadata) must be DENIED loudly, never executed
 * into a fake success. The runner's equivalent voice (throwing
 * ToolDeniedError) must likewise produce DENIED, not TIMED_OUT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/registry';
import { ToolDeniedError, ToolExecutor } from '../src/executor';
import type { ToolCall, ToolMetadata } from '../src/types';
import { TOOL_CATEGORIES } from '../src/types';

const PRINCIPAL = { id: 'p1', kind: 'human' } as const;
const CAPABILITY = {
  id: 'cap1',
  principalId: 'p1',
  actions: ['act'],
  resourcePrefixes: ['res'],
  revoked: false,
} as const;

function meta(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 't.read',
    version: '1',
    source: 'builtin',
    category: TOOL_CATEGORIES[0],
    implementationStatus: 'definition-only',
    inputSchema: {},
    outputSchema: {},
    capabilities: ['act'],
    sideEffect: 'read-only',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 1000,
    idempotency: false,
    cancelable: false,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
    ...overrides,
  } as ToolMetadata;
}

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolId: 't.read',
    args: {},
    action: 'act',
    resource: 'res/x',
    principal: { ...PRINCIPAL },
    capability: { ...CAPABILITY },
    ...overrides,
  } as ToolCall;
}

describe('implementationGate', () => {
  it('denies a definition-only tool with UNSUPPORTED_CAPABILITY and audits it', async () => {
    const registry = new ToolRegistry();
    registry.register(meta());
    const ex = new ToolExecutor(registry, {
      runner: () => {
        throw new Error('must never run');
      },
      implementationGate: (tool) =>
        tool.implementationStatus === 'definition-only'
          ? { code: 'UNSUPPORTED_CAPABILITY', message: `tool ${tool.id} is definition-only` }
          : null,
    });
    const record = await ex.execute(call());
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /UNSUPPORTED_CAPABILITY/);
    assert.match(record.note ?? '', /definition-only/);
    // Audited like any other denial.
    const attempts = ex.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'DENIED');
  });

  it('lets a wired tool through to the runner', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 't.echo', implementationStatus: 'implemented' }));
    const ex = new ToolExecutor(registry, {
      runner: () => ({ exitCode: 0, stdout: 'hi', stderr: '' }),
      implementationGate: (tool) =>
        tool.implementationStatus === 'definition-only'
          ? { code: 'UNSUPPORTED_CAPABILITY', message: 'no impl' }
          : null,
    });
    const record = await ex.execute(call({ toolId: 't.echo' }));
    assert.equal(record.outcome, 'SUCCEEDED');
    assert.equal(record.stdout, 'hi');
  });

  it('absent gate keeps legacy behavior (no implementation check)', async () => {
    const registry = new ToolRegistry();
    registry.register(meta());
    const ex = new ToolExecutor(registry, {
      runner: () => ({ exitCode: 0, stdout: 'hi', stderr: '' }),
    });
    const record = await ex.execute(call());
    assert.equal(record.outcome, 'SUCCEEDED');
  });

  it('gate runs before the approval gate (host capability first)', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ approvalPolicy: 'HUMAN_APPROVAL' }));
    const ex = new ToolExecutor(registry, {
      runner: () => ({ exitCode: 0, stdout: 'hi', stderr: '' }),
      implementationGate: () => ({ code: 'UNSUPPORTED_CAPABILITY', message: 'no impl on host' }),
      // No approvalChecker: would deny fail-closed with POLICY_DENIED —
      // the implementation gate must win with UNSUPPORTED_CAPABILITY.
    });
    const record = await ex.execute(call());
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /UNSUPPORTED_CAPABILITY/);
  });
});

describe('runner ToolDeniedError', () => {
  it('converts to DENIED (not TIMED_OUT) with the runner reason code', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ implementationStatus: 'implemented' }));
    const ex = new ToolExecutor(registry, {
      runner: () => {
        throw new ToolDeniedError('POLICY_DENIED', 'command refused: binary not in whitelist');
      },
    });
    const record = await ex.execute(call());
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /POLICY_DENIED/);
    assert.match(record.note ?? '', /not in whitelist/);
  });

  it('other runner errors keep the legacy TIMED_OUT mapping', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ implementationStatus: 'implemented' }));
    const ex = new ToolExecutor(registry, {
      runner: () => {
        throw new Error('boom');
      },
    });
    const record = await ex.execute(call());
    assert.equal(record.outcome, 'TIMED_OUT');
  });

  it('executeOrThrow throws ToolDeniedError for gate denials', async () => {
    const registry = new ToolRegistry();
    registry.register(meta());
    const ex = new ToolExecutor(registry, {
      runner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      implementationGate: () => ({ code: 'UNSUPPORTED_CAPABILITY', message: 'no impl' }),
    });
    await assert.rejects(() => ex.executeOrThrow(call()), (err: unknown) => {
      assert.ok(err instanceof ToolDeniedError);
      assert.equal((err as ToolDeniedError).reasonCode, 'UNSUPPORTED_CAPABILITY');
      return true;
    });
  });
});
