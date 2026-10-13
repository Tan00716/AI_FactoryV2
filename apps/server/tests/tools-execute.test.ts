/**
 * §33 execution-surface unification — Batch 21.
 *
 * What this pins:
 *  1. The server tool runner executes for real where the server has a
 *     real implementation (runtime.echo/add; shell.execute through the
 *     SAME command policy /api/exec enforces) — no more prototype
 *     runner faking exitCode 0 for every tool.
 *  2. definition-only tools are DENIED loudly (UNSUPPORTED_CAPABILITY)
 *     via the implementation gate — "not implemented" can never
 *     become "success".
 *  3. Implemented-but-unwired tools (git.*, test.run, …) FAILED loudly
 *     with a stderr naming the gap — audited, never silent.
 *  4. Runner policy refusals (whitelist/deny patterns, control-plane
 *     dir) surface as DENIED (POLICY_DENIED), not TIMED_OUT.
 *  5. shell.execute is HUMAN_APPROVAL with no approval checker wired
 *     on this server → stays DENIED fail-closed (§23.4), documented.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolExecutor,
  ToolRegistry,
  type ResolvedToolCall,
  type ToolCall,
  type ToolMetadata,
} from '@ai-factory/tools';
import {
  SERVER_WIRED_TOOLS,
  createImplementationGate,
  createServerToolRunner,
} from '../dist/tool-runner.js';
// NOTE (Batch 21 closeout): tool-runner.ts value-imports './routes/exec'
// extensionless, which tsc resolves but node type-stripping cannot.
// Tests import the compiled dist here so both modes work; run
// `npm run build` (root) before the server suite.

const PRINCIPAL = { id: 'p1', kind: 'human' } as const;
const CAPABILITY = {
  id: 'cap1',
  principalId: 'p1',
  actions: ['*'],
  resourcePrefixes: [''],
  revoked: false,
} as const;

function meta(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 'x',
    version: '1',
    source: 'test',
    implementationStatus: 'implemented',
    inputSchema: {},
    outputSchema: {},
    capabilities: ['*'],
    sideEffect: 'none',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 15000,
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
    toolId: 'x',
    args: {},
    action: '*',
    resource: 'res',
    principal: { ...PRINCIPAL },
    capability: { ...CAPABILITY },
    ...overrides,
  } as ToolCall;
}

function wiredExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  return new ToolExecutor(registry, {
    runner: createServerToolRunner(),
    implementationGate: createImplementationGate(),
    approvalChecker: () => ({ approved: true, reason: 'test' }),
  });
}

describe('server implementation gate', () => {
  it('denies definition-only tools with UNSUPPORTED_CAPABILITY', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 'fs.read', implementationStatus: 'definition-only' }));
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(call({ toolId: 'fs.read' }));
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /UNSUPPORTED_CAPABILITY/);
    assert.match(record.note ?? '', /definition-only/);
  });

  it('lets server-wired tools pass the gate even when definition-only in the catalog', async () => {
    // shell.execute is definition-only in the builtin taxonomy (17-4:
    // host-injected implementations) — the SERVER wires a real one, so
    // the gate must not deny it. Approval stays fail-closed (§23.4).
    assert.ok(SERVER_WIRED_TOOLS.has('shell.execute'));
    const registry = new ToolRegistry();
    registry.register(
      meta({ id: 'shell.execute', implementationStatus: 'definition-only', approvalPolicy: 'HUMAN_APPROVAL' }),
    );
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
      // no approvalChecker → HUMAN_APPROVAL denies fail-closed
    });
    const record = await ex.execute(call({ toolId: 'shell.execute', args: { command: 'echo hi' } }));
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /HUMAN_APPROVAL/);
  });
});

describe('server runner: real execution', () => {
  it('runtime.echo returns its payload (SUCCEEDED)', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 'runtime.echo' }));
    const ex2 = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex2.execute(call({ toolId: 'runtime.echo', args: { msg: 'ping' } }));
    assert.equal(record.outcome, 'SUCCEEDED');
    assert.equal(record.stdout, 'ping');
    assert.equal(record.exitCode, 0);
  });

  it('runtime.add computes (SUCCEEDED)', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 'runtime.add' }));
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(call({ toolId: 'runtime.add', args: { a: 2, b: 3 } }));
    assert.equal(record.outcome, 'SUCCEEDED');
    assert.equal(record.stdout, '5');
  });

  it('runtime.echo with empty output is EMPTY_RESULT, not success', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 'runtime.echo' }));
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(call({ toolId: 'runtime.echo', args: {} }));
    assert.equal(record.outcome, 'EMPTY_RESULT');
  });

  it('shell.execute really runs an allowed command', async () => {
    const registry = new ToolRegistry();
    registry.register(
      meta({ id: 'shell.execute', implementationStatus: 'definition-only', approvalPolicy: 'AUTO' }),
    );
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(call({ toolId: 'shell.execute', args: { command: 'echo real-run' } }));
    assert.equal(record.outcome, 'SUCCEEDED');
    assert.match(record.stdout, /real-run/);
    assert.equal(record.exitCode, 0);
  });

  it('shell.execute policy refusal is DENIED, not TIMED_OUT', async () => {
    const registry = new ToolRegistry();
    registry.register(
      meta({ id: 'shell.execute', implementationStatus: 'definition-only', approvalPolicy: 'AUTO' }),
    );
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    // 'rm' is not in the binary whitelist → shared command policy refuses.
    const record = await ex.execute(call({ toolId: 'shell.execute', args: { command: 'rm -rf /tmp/x' } }));
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /POLICY_DENIED/);
  });

  it('shell.execute deny-pattern refusal is DENIED', async () => {
    const registry = new ToolRegistry();
    registry.register(
      meta({ id: 'shell.execute', implementationStatus: 'definition-only', approvalPolicy: 'AUTO' }),
    );
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(
      call({ toolId: 'shell.execute', args: { command: 'echo hi; rm -rf /' } }),
    );
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /POLICY_DENIED/);
  });

  it('implemented-but-unwired tool FAILS loudly, never silently succeeds', async () => {
    const registry = new ToolRegistry();
    registry.register(meta({ id: 'git.commit', implementationStatus: 'implemented' }));
    const ex = new ToolExecutor(registry, {
      runner: createServerToolRunner(),
      implementationGate: createImplementationGate(),
    });
    const record = await ex.execute(call({ toolId: 'git.commit', args: { message: 'x' } }));
    assert.equal(record.outcome, 'FAILED');
    assert.match(record.stderr, /no implementation is wired/);
    assert.match(record.stderr, /refusing to fake execution/);
  });

  it('unknown tool stays UNSUPPORTED_CAPABILITY', async () => {
    const ex = wiredExecutor();
    const record = await ex.execute(call({ toolId: 'nope.missing' }));
    assert.equal(record.outcome, 'DENIED');
    assert.match(record.note ?? '', /UNSUPPORTED_CAPABILITY/);
  });
});

describe('reachability matrix: all 16 builtins', () => {
  it('every builtin either runs or is loudly refused', async () => {
    // The 8 definition-only builtins must DENY; the 3 server-wired run;
    // the other 5 implemented-but-unwired FAIL loudly. Nothing may
    // return a fake success or fall through silently.
    const { createBuiltinToolRegistry } = await import('@ai-factory/tools');
    const catalog = createBuiltinToolRegistry();
    const defOnly = catalog.list().filter((t) => t.implementationStatus === 'definition-only');
    assert.equal(defOnly.length, 8);
    const gate = createImplementationGate();
    for (const t of catalog.list()) {
      const verdict = gate(t as ToolMetadata, call({ toolId: t.id }) as ToolCall);
      if (SERVER_WIRED_TOOLS.has(t.id)) {
        assert.equal(verdict, null, `${t.id} is server-wired and must pass the gate`);
      } else if (t.implementationStatus === 'definition-only') {
        assert.ok(verdict, `${t.id} is definition-only and must be denied`);
        assert.equal(verdict!.code, 'UNSUPPORTED_CAPABILITY');
      } else {
        assert.equal(verdict, null, `${t.id} is implemented; the runner loud-FAILS it`);
      }
    }
  });
});
