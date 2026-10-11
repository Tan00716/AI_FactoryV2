/**
 * Tool executor tests — SPEC v2 §33.
 * Key property: alternate tool paths get the SAME verdict (action+resource,
 * never tool name). Exit code is the truth.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolDeniedError,
  ToolExecutor,
  ToolRegistry,
  type CapabilityGrant,
  type ToolCall,
  type ToolMetadata,
  type ToolPrincipal,
} from '../src/index';

const PRINCIPAL: ToolPrincipal = { id: 'ai:coder-1', type: 'AI' };

function fsWriteTool(id: string): ToolMetadata {
  return {
    id,
    version: '1.0.0',
    source: 'builtin',
    inputSchema: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    outputSchema: {},
    capabilities: ['filesystem.write'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: ['/ws/'],
    timeoutMs: 5_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'healthy',
    approvalPolicy: 'AUTO',
  };
}

function grant(over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: 'cap-1',
    principalId: PRINCIPAL.id,
    actions: ['filesystem.write'],
    resourcePrefixes: ['/ws/project-a/'],
    expiresAt: null,
    ...over,
  };
}

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    toolId: 'fs.write',
    args: { path: '/ws/project-a/notes.txt', content: 'hi' },
    action: 'filesystem.write',
    resource: '/ws/project-a/notes.txt',
    principal: PRINCIPAL,
    capability: grant(),
    ...over,
  };
}

describe('alternate tool paths share one policy', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let runs: string[];

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    // The "alternate path": python's open(), same logical action.
    registry.register({ ...fsWriteTool('python.open'), source: 'interpreter' });
    runs = [];
    executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: (c) => {
        runs.push(c.tool.id);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });
  });

  it('denies BOTH fs.write and python.open when the action is not granted', async () => {
    const denied = grant({ actions: ['filesystem.read'] });
    const r1 = await executor.execute(call({ toolId: 'fs.write', capability: denied }));
    const r2 = await executor.execute(call({ toolId: 'python.open', capability: denied }));
    assert.equal(r1.outcome, 'DENIED');
    assert.equal(r2.outcome, 'DENIED');
    assert.match(r1.note ?? '', /POLICY_DENIED/);
    assert.match(r2.note ?? '', /POLICY_DENIED/);
    assert.deepEqual(runs, [], 'neither tool may run');
  });

  it('allows both when the action IS granted — verdict follows the grant', async () => {
    const r1 = await executor.execute(call({ toolId: 'fs.write' }));
    const r2 = await executor.execute(call({ toolId: 'python.open' }));
    assert.equal(r1.outcome, 'SUCCEEDED');
    assert.equal(r2.outcome, 'SUCCEEDED');
    assert.deepEqual(runs, ['fs.write', 'python.open']);
  });

  it('denies when the resource is outside granted prefixes (SCOPE_VIOLATION)', async () => {
    const r = await executor.execute(
      call({ resource: '/ws/project-b/secret.txt', args: { path: '/ws/project-b/secret.txt', content: 'x' } }),
    );
    assert.equal(r.outcome, 'DENIED');
    assert.match(r.note ?? '', /SCOPE_VIOLATION/);
  });

  it('denies a revoked or expired grant', async () => {
    const r1 = await executor.execute(call({ capability: grant({ revoked: true }) }));
    assert.equal(r1.outcome, 'DENIED');
    assert.match(r1.note ?? '', /UNAUTHORIZED/);
    const r2 = await executor.execute(
      call({ capability: grant({ expiresAt: '2020-01-01T00:00:00.000Z' }) }),
    );
    assert.equal(r2.outcome, 'DENIED');
    assert.match(r2.note ?? '', /AUTHORIZATION_EXPIRED/);
  });
});

describe('exit-code truth and records', () => {
  it('natural-language "success" never overrides a non-zero exit code', async () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => ({ exitCode: 1, stdout: '', stderr: 'boom', note: 'success' }),
    });
    const r = await executor.execute(call());
    assert.equal(r.exitCode, 1);
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.note, 'success', 'runner note preserved verbatim, not trusted');
  });

  it('redacts secret references from the audit record', async () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => ({ exitCode: 0, stdout: 'wrote secret://db/password ok', stderr: '' }),
    });
    const r = await executor.execute(
      call({ args: { path: '/ws/project-a/c.env', content: 'x secret://db/password y' } }),
    );
    assert.equal(r.redacted, true);
    assert.ok(!JSON.stringify(r.argv).includes('secret://db/password'));
    assert.ok(!r.stdout.includes('secret://db/password'));
    assert.ok(r.stdout.includes('***'));
  });

  it('idempotency key prevents re-execution', async () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    let runs = 0;
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const c = call({ idempotencyKey: 'idem-1' });
    const r1 = await executor.execute(c);
    const r2 = await executor.execute(c);
    assert.equal(runs, 1);
    assert.equal(r1.id, r2.id);
    assert.match(r2.note ?? '', /not re-executed/);
  });

  it('input schema violations deny before execution', async () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    let runs = 0;
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const r = await executor.execute(call({ args: { path: '/ws/project-a/x' } }));
    assert.equal(r.outcome, 'DENIED');
    assert.equal(runs, 0);
  });

  it('executeOrThrow raises ToolDeniedError on denial', async () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    await assert.rejects(
      () => executor.executeOrThrow(call({ capability: grant({ actions: [] }) })),
      (err: unknown) => err instanceof ToolDeniedError && err.reasonCode === 'POLICY_DENIED',
    );
  });

  it('BLOCKED tools are denied without running', async () => {
    const registry = new ToolRegistry();
    registry.register({ ...fsWriteTool('evil.tool'), approvalPolicy: 'BLOCKED' });
    let runs = 0;
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const r = await executor.execute(call({ toolId: 'evil.tool' }));
    assert.equal(r.outcome, 'DENIED');
    assert.match(r.note ?? '', /POLICY_DENIED/);
    assert.equal(runs, 0);
  });
});

describe('registry', () => {
  it('pins exact versions and rejects duplicates', () => {
    const registry = new ToolRegistry();
    registry.register(fsWriteTool('fs.write'));
    registry.register({ ...fsWriteTool('fs.write'), version: '2.0.0' });
    assert.deepEqual(registry.listVersions('fs.write'), ['1.0.0', '2.0.0']);
    assert.equal(registry.get('fs.write', '1.0.0').version, '1.0.0');
    assert.throws(() => registry.register(fsWriteTool('fs.write')), /already registered/);
  });
});

describe('§23.4 approval gate at execution point', () => {
  function gatedExecutor(
    policy: 'HUMAN_APPROVAL' | 'AI_REVIEW_PLUS_POLICY' | 'AUTO',
    opts: Partial<import('../src/index').ExecutorOptions> = {},
  ) {
    const registry = new ToolRegistry();
    registry.register({ ...fsWriteTool('gated.tool'), approvalPolicy: policy });
    let runs = 0;
    const executor = new ToolExecutor(registry, {
      now: () => 1_700_000_000_000,
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ...opts,
    });
    return { executor, runs: () => runs };
  }

  it('HUMAN_APPROVAL tool executes when the checker approves', async () => {
    const { executor, runs } = gatedExecutor('HUMAN_APPROVAL', {
      approvalChecker: () => ({ approved: true, approvalId: 'appr-1' }),
    });
    const r = await executor.execute(call({ toolId: 'gated.tool' }));
    assert.equal(r.outcome, 'SUCCEEDED');
    assert.equal(runs(), 1);
  });

  it('HUMAN_APPROVAL tool is DENIED when the checker denies', async () => {
    const { executor, runs } = gatedExecutor('HUMAN_APPROVAL', {
      approvalChecker: () => ({ approved: false, reason: 'human said no' }),
    });
    const r = await executor.execute(call({ toolId: 'gated.tool' }));
    assert.equal(r.outcome, 'DENIED');
    assert.match(r.note ?? '', /POLICY_DENIED/);
    assert.match(r.note ?? '', /human said no/);
    assert.equal(runs(), 0);
  });

  it('AI_REVIEW_PLUS_POLICY tool is DENIED fail-closed without a checker', async () => {
    const { executor, runs } = gatedExecutor('AI_REVIEW_PLUS_POLICY');
    const r = await executor.execute(call({ toolId: 'gated.tool' }));
    assert.equal(r.outcome, 'DENIED');
    assert.match(r.note ?? '', /no approval checker is configured/);
    assert.equal(runs(), 0);
    // The denial is audit-logged.
    assert.equal(executor.attempts().length, 1);
    assert.equal(executor.attempts()[0].outcome, 'DENIED');
  });

  it('checker errors are DENIED, not executed', async () => {
    const { executor, runs } = gatedExecutor('HUMAN_APPROVAL', {
      approvalChecker: () => {
        throw new Error('checker exploded');
      },
    });
    const r = await executor.execute(call({ toolId: 'gated.tool' }));
    assert.equal(r.outcome, 'DENIED');
    assert.match(r.note ?? '', /approval checker error/);
    assert.equal(runs(), 0);
  });

  it('AUTO tools are unaffected by the gate', async () => {
    const { executor, runs } = gatedExecutor('AUTO');
    const r = await executor.execute(call({ toolId: 'gated.tool' }));
    assert.equal(r.outcome, 'SUCCEEDED');
    assert.equal(runs(), 1);
  });
});
