/**
 * Tests for §34.4: classify → bounded retry → circuit breaker →
 * compatible alternative (same authorization), with escalation when
 * the chain is exhausted.
 * Run: node --test dist/tests/resilience.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  McpManager,
  McpRegistry,
  McpResilience,
  findCompatibleAlternatives,
  withBoundedRetry,
} from '../src/index';
import { errJsonRpc, errUnreachable } from './fixtures/fake-mcp-server';

function manualClock(start = 10_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('opens after the failure threshold, half-opens after cooldown, closes on probe success', () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, clock });
    assert.equal(b.snapshot().state, 'CLOSED');
    b.recordFailure('unreachable');
    b.recordFailure('unreachable');
    assert.equal(b.snapshot().state, 'CLOSED');
    const opened = b.recordFailure('timeout');
    assert.equal(opened.state, 'OPEN');
    assert.equal(opened.lastFailureClass, 'timeout');
    assert.equal(b.canExecute(), false);

    clock.advance(999);
    assert.equal(b.canExecute(), false);
    clock.advance(1);
    assert.equal(b.snapshot().state, 'HALF_OPEN');
    assert.equal(b.canExecute(), true); // the single probe
    assert.equal(b.canExecute(), false); // no second call while the probe is in flight

    const closed = b.recordSuccess();
    assert.equal(closed.state, 'CLOSED');
    assert.equal(closed.consecutiveFailures, 0);
    assert.equal(b.canExecute(), true);
  });

  it('a failed half-open probe re-opens the circuit with a fresh cooldown', () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, clock });
    b.recordFailure('unreachable');
    assert.equal(b.snapshot().state, 'OPEN');
    clock.advance(500);
    assert.equal(b.canExecute(), true);
    const reopened = b.recordFailure('unreachable');
    assert.equal(reopened.state, 'OPEN');
    assert.equal(b.canExecute(), false);
    clock.advance(499);
    assert.equal(b.canExecute(), false);
    clock.advance(1);
    assert.equal(b.canExecute(), true);
  });
});

describe('withBoundedRetry', () => {
  it('retries retryable classes with exponential backoff and returns the value', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const value = await withBoundedRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw errUnreachable();
        return 'done';
      },
      { maxAttempts: 3, baseDelayMs: 100 },
      async (ms) => { delays.push(ms); },
    );
    assert.equal(value, 'done');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('does NOT retry protocol/tool failures — their side effects are unknown (§34.4)', async () => {
    let attempts = 0;
    await assert.rejects(() =>
      withBoundedRetry(
        async () => { attempts += 1; throw errJsonRpc(); },
        { maxAttempts: 5 },
        async () => {},
      ),
    );
    assert.equal(attempts, 1);
  });

  it('stops at the attempt bound and rethrows', async () => {
    let attempts = 0;
    await assert.rejects(() =>
      withBoundedRetry(
        async () => { attempts += 1; throw errUnreachable(); },
        { maxAttempts: 2 },
        async () => {},
      ),
    );
    assert.equal(attempts, 2);
  });
});

function world() {
  const registry = new McpRegistry();
  const manager = new McpManager(registry);
  const mk = (name: string, tools: string[], trust: 'HIGH' | 'VERIFIED' = 'HIGH') => {
    registry.register(
      { name, version: '1.0.0', provider: 'Acme', transport: 'http' as const, tools: tools.map((t) => ({ name: t })) },
      { trust, policy: 'AUTO' },
    );
    manager.requestInstall(name, '1.0.0');
  };
  mk('alpha', ['read', 'write'], 'HIGH'); // the one that will fail
  mk('beta', ['read', 'write'], 'VERIFIED'); // full-coverage alternative
  mk('gamma', ['read'], 'HIGH'); // partial coverage
  return { registry, manager };
}

describe('findCompatibleAlternatives', () => {
  it('suggests installed+enabled servers under the same authorization, full coverage first, never the failed server itself', () => {
    const { registry, manager } = world();
    manager.setEnabled('gamma', '1.0.0', false, { kind: 'project', id: 'p1' });
    const suggestions = findCompatibleAlternatives(registry, manager, {
      failedServer: 'alpha',
      failedVersion: '1.0.0',
      requiredTools: ['read', 'write'],
      scopes: [{ kind: 'project', id: 'p1' }],
    });
    // gamma is disabled for project p1 → excluded under the same authorization
    assert.deepEqual(suggestions.map((s) => s.name), ['beta']);
    assert.equal(suggestions[0].fullCoverage, true);

    const noScope = findCompatibleAlternatives(registry, manager, {
      failedServer: 'alpha',
      failedVersion: '1.0.0',
      requiredTools: ['read', 'write'],
    });
    assert.deepEqual(noScope.map((s) => s.name), ['beta', 'gamma']);
    assert.equal(noScope[1].fullCoverage, false);
    assert.deepEqual(noScope[1].missingTools, ['write']);
  });
});

describe('McpResilience.execute (§34.4 chain)', () => {
  it('classifies, retries within the bound, opens the circuit, then refuses fast with alternatives + escalate', async () => {
    const { registry, manager } = world();
    const clock = manualClock();
    const resilience = new McpResilience({
      registry,
      manager,
      breaker: { failureThreshold: 2, cooldownMs: 60_000, clock },
      retry: { maxAttempts: 2, baseDelayMs: 1 },
      sleep: async () => {},
    });
    const alwaysDown = async () => { throw errUnreachable(); };

    const first = await resilience.execute({ name: 'alpha', version: '1.0.0' }, alwaysDown, { requiredTools: ['read'] });
    assert.equal(first.ok, false);
    assert.equal(first.attempts, 2); // bounded retry ran the operation twice
    assert.equal(first.failureClass, 'unreachable');
    assert.equal(first.escalated, true);
    assert.equal(first.circuit.state, 'CLOSED'); // 1 consecutive failure < threshold 2
    assert.deepEqual(first.alternatives.map((a) => a.name), ['beta', 'gamma']);

    const second = await resilience.execute({ name: 'alpha', version: '1.0.0' }, alwaysDown, { requiredTools: ['read'] });
    assert.equal(second.circuit.state, 'OPEN');

    let ran = 0;
    const third = await resilience.execute(
      { name: 'alpha', version: '1.0.0' },
      async () => { ran += 1; return 'x'; },
      { requiredTools: ['read'] },
    );
    assert.equal(third.ok, false);
    assert.equal(third.attempts, 0); // open circuit: the operation never ran
    assert.equal(ran, 0);
    assert.match(third.error ?? '', /circuit OPEN/);
    assert.equal(third.escalated, true);
  });

  it('a success resets the breaker and reports no escalation', async () => {
    const { registry, manager } = world();
    const resilience = new McpResilience({ registry, manager, sleep: async () => {} });
    const out = await resilience.execute({ name: 'alpha', version: '1.0.0' }, async () => 42);
    assert.equal(out.ok, true);
    assert.equal(out.value, 42);
    assert.equal(out.attempts, 1);
    assert.equal(out.escalated, false);
    assert.equal(out.circuit.state, 'CLOSED');
  });
});
