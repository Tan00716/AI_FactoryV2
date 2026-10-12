/**
 * Tests for the real CodexAdapter (spec §27/§28) — no real codex binary,
 * no login, no network: the adapter spawns tests/fixtures/fake-codex-server.mjs
 * (a Node script speaking the NDJSON JSON-RPC subset) in spawn mode.
 *
 * Run: node --test dist/tests/codex-adapter.test.js   (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CodexAdapter, CodexAdapterError, type CodexAdapterConfig } from '../src/index';

// Compiled tests live in dist/tests/; the fixture ships in the source tree.
const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-codex-server.mjs');

function fakeAdapter(scenario: string, extra: Partial<CodexAdapterConfig> = {}): CodexAdapter {
  return new CodexAdapter({
    auth: 'chatgpt-oauth',
    command: process.execPath, // node
    args: [FIXTURE, scenario],
    timeoutMs: 10_000,
    ...extra,
  });
}

describe('CodexAdapter against the fake app-server', () => {
  it('completes a turn: agentMessage text concatenates, toolCalls stay [], actions are observed', async () => {
    const out = await fakeAdapter('ok').invoke({ prompt: 'say hi', tools: ['read'] });
    assert.equal(out.text, 'First line\nSecond line');
    assert.deepEqual(out.toolCalls, []);
    assert.ok(out.actions, 'actions recorded');
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].kind, 'commandExecution');
    assert.match(out.actions[0].summary, /ls -la/);
    assert.match(out.actions[0].summary, /exit=0/);
  });

  it('a failed turn throws CodexAdapterError carrying the server error text', async () => {
    await assert.rejects(
      fakeAdapter('fail-turn').invoke({ prompt: 'x', tools: [] }),
      (err: unknown) =>
        err instanceof CodexAdapterError && /not logged in/.test((err as Error).message),
    );
  });

  it('a server that exits immediately fails the invoke instead of hanging', async () => {
    await assert.rejects(
      fakeAdapter('exit-now').invoke({ prompt: 'x', tools: [] }),
      (err: unknown) =>
        err instanceof CodexAdapterError && /exited|spawn/i.test((err as Error).message),
    );
  });

  it('a missing codex binary fails closed with an actionable error', async () => {
    const adapter = new CodexAdapter({
      auth: 'api-key',
      command: 'ai-factory-definitely-not-a-codex-binary',
      timeoutMs: 5_000,
    });
    await assert.rejects(
      adapter.invoke({ prompt: 'x', tools: [] }),
      (err: unknown) =>
        err instanceof CodexAdapterError && /spawn failed|exited/i.test((err as Error).message),
    );
  });

  it('times out when the server never completes the turn, and cleans up', async () => {
    const started = Date.now();
    await assert.rejects(
      fakeAdapter('hang', { timeoutMs: 300 }).invoke({ prompt: 'x', tools: [] }),
      (err: unknown) =>
        err instanceof CodexAdapterError && /timed out after 300ms/.test((err as Error).message),
    );
    assert.ok(Date.now() - started < 5_000, 'timeout path must not hang');
  });

  it('getAccountStatus returns the real (fake-server) account shape', async () => {
    const status = await fakeAdapter('ok').getAccountStatus();
    assert.equal(status.reachable, true);
    assert.equal(status.authMethod, 'chatgpt');
    assert.equal(status.requiresOpenaiAuth, true);
    assert.equal(status.account?.type, 'chatgpt');
    assert.equal(status.account?.email, 'fake@example.com');
    assert.equal(status.account?.planType, 'plus');
    assert.ok(status.rateLimits, 'rate limits snapshot passed through');
  });

  it('getAccountStatus reports unreachable honestly instead of fabricating', async () => {
    const status = await fakeAdapter('exit-now').getAccountStatus();
    assert.equal(status.reachable, false);
    assert.equal(status.authMethod, null);
    assert.equal(status.account, null);
    assert.ok(status.error && status.error.length > 0);
  });
});
