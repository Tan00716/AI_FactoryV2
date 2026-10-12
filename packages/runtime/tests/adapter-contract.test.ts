/**
 * §26.2 Adapter Contract Tests — one battery, every shipped adapter.
 *
 * The spec demands repeatable contract tests: the same assertions run
 * over StubAdapter (scripted) and CodexAdapter (against the fake
 * app-server fixture — no real codex binary, no login, no network).
 * Where the two adapters legitimately differ (scripted values vs live
 * values, stub's UNSUPPORTED cancelTurn), the battery pins each one's
 * honest behavior instead of forcing a false uniformity:
 *  - capabilities.cancellation must agree with cancelTurn's behavior;
 *  - quota/account numbers must come from the fixture, or be absent —
 *    never invented;
 *  - a cancellation is only ever reported after provider confirmation.
 *
 * Run: node --test dist/tests/adapter-contract.test.js   (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  AdapterTurnCancelledError,
  AdapterUnsupportedError,
  CodexAdapter,
  CodexAdapterError,
  StubAdapter,
  isAdapterContract,
  type AdapterContract,
  type AdapterEvent,
  type CodexAdapterConfig,
} from '../src/index';

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-codex-server.mjs');

function fakeCodex(scenario: string, extra: Partial<CodexAdapterConfig> = {}): CodexAdapter {
  return new CodexAdapter({
    auth: 'chatgpt-oauth',
    command: process.execPath,
    args: [FIXTURE, scenario],
    timeoutMs: 10_000,
    ...extra,
  });
}

async function collectEvents(it: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONTRACT_METHODS = [
  'discoverCapabilities',
  'getAccountStatus',
  'getQuota',
  'startSession',
  'runTurn',
  'streamEvents',
  'cancelTurn',
  'exportCheckpoint',
  'recoverSession',
  'closeSession',
] as const;

describe('§26.2 adapter contract — surface', () => {
  it('both shipped adapters implement the full 10-method contract', () => {
    const adapters: AdapterContract[] = [new StubAdapter([]), fakeCodex('ok')];
    for (const a of adapters) {
      assert.ok(isAdapterContract(a), `${a.name} must satisfy isAdapterContract`);
      assert.ok(a.name.length > 0);
      for (const m of CONTRACT_METHODS) {
        assert.equal(typeof (a as any)[m], 'function', `${a.name}.${m} must exist`);
      }
      // invoke() (the one-shot RuntimeAdapter surface) stays available.
      assert.equal(typeof a.invoke, 'function');
    }
  });

  it('discoverCapabilities returns the §26.1 shape with honest provenance', async () => {
    const stubCaps = await new StubAdapter([]).discoverCapabilities();
    assert.equal(stubCaps.adapter, 'stub');
    assert.equal(stubCaps.cancellation, false, 'stub declares what it cannot do');
    assert.equal(stubCaps.maxContext, 'unknown');

    const codexCaps = await fakeCodex('ok').discoverCapabilities();
    assert.equal(codexCaps.adapter, 'codex');
    assert.equal(codexCaps.protocol.name, 'codex-app-server');
    assert.equal(
      codexCaps.protocol.serverInfo,
      'fake-codex/0.0.0',
      'server identity comes from the real initialize handshake',
    );
    for (const k of ['tools', 'structuredOutput', 'vision', 'reasoning', 'streaming', 'cancellation', 'resume'] as const) {
      assert.equal(typeof codexCaps[k], 'boolean', `capabilities.${k} is boolean`);
    }
    assert.equal(codexCaps.structuredOutput, false);
    assert.equal(codexCaps.maxContext, 'unknown', 'not reported by handshake → unknown, not guessed');
    assert.ok(codexCaps.notes.length > 0, 'provenance notes are part of the shape');
  });

  it('capabilities.cancellation agrees with cancelTurn behavior on both adapters', async () => {
    const stub = new StubAdapter([]);
    const stubCaps = await stub.discoverCapabilities();
    const s = await stub.startSession();
    await assert.rejects(
      stub.cancelTurn(s.sessionId),
      (err: unknown) =>
        err instanceof AdapterUnsupportedError &&
        (err as AdapterUnsupportedError).code === 'UNSUPPORTED',
      'an adapter declaring cancellation:false must signal UNSUPPORTED, not fake a cancel',
    );
    assert.equal(stubCaps.cancellation, false);
    await stub.closeSession(s.sessionId);

    const codexCaps = await fakeCodex('ok').discoverCapabilities();
    assert.equal(codexCaps.cancellation, true, 'codex declares turn/interrupt support');
  });
});

describe('§26.2 adapter contract — account & quota honesty', () => {
  it('getAccountStatus: codex reports the fixture account as live; stub labels itself', async () => {
    const live = await fakeCodex('ok').getAccountStatus();
    assert.equal(live.reachable, true);
    assert.equal(live.source, 'live');
    assert.equal(live.authenticated, true);
    assert.equal(live.account?.email, 'fake@example.com');
    assert.equal(live.account?.planType, 'plus');

    const stub = await new StubAdapter([]).getAccountStatus();
    assert.equal(stub.source, 'stub');
    assert.equal(stub.account, null, 'a stub never invents an account');
  });

  it('getAccountStatus: an unreachable codex server reports source none, no fabrication', async () => {
    const dead = await fakeCodex('exit-now').getAccountStatus();
    assert.equal(dead.reachable, false);
    assert.equal(dead.source, 'none');
    assert.equal(dead.authenticated, null);
    assert.equal(dead.account, null);
    assert.ok(dead.error);
  });

  it('getQuota: codex maps the fixture rate-limit window; null windows stay absent', async () => {
    const q = await fakeCodex('ok').getQuota();
    assert.equal(q.source, 'live');
    assert.equal(typeof q.collectedAt, 'number');
    assert.equal(q.buckets.length, 1, 'secondary window is null in the fixture → no bucket');
    const b = q.buckets[0];
    assert.equal(b.id, 'codex:primary');
    assert.equal(b.usedPct, 25);
    assert.equal(b.remainingPct, 75, 'remaining is derived from the reported usedPct only');
    assert.equal(b.windowDurationMins, 300);
    assert.equal(b.resetsAt, 1890000000 * 1000, 'epoch seconds normalized to ms');
  });

  it('getQuota: stub reports no buckets rather than inventing percentages', async () => {
    const q = await new StubAdapter([]).getQuota();
    assert.equal(q.source, 'stub');
    assert.deepEqual(q.buckets, []);
  });

  it('getQuota: an unreachable codex server reports source none with an error', async () => {
    const q = await fakeCodex('exit-now').getQuota();
    assert.equal(q.source, 'none');
    assert.deepEqual(q.buckets, []);
    assert.ok(q.error);
  });
});

describe('§26.2 adapter contract — session lifecycle', () => {
  it('stub: start → runTurn → stream → export → close → recover continues the script', async () => {
    const stub = new StubAdapter([
      { text: 'first', toolCalls: [{ tool: 'read', args: { path: 'a' } }] },
      { text: 'second', toolCalls: [] },
    ]);
    const s = await stub.startSession();
    assert.ok(s.sessionId.length > 0);
    assert.equal(s.adapter, 'stub');

    const out1 = await stub.runTurn(s.sessionId, { prompt: 'p', tools: ['read'] });
    assert.equal(out1.text, 'first');
    assert.deepEqual(out1.toolCalls, [{ tool: 'read', args: { path: 'a' } }]);

    const events = await collectEvents(stub.streamEvents(s.sessionId));
    assert.ok(events.length >= 2);
    assert.equal(events[events.length - 1].type, 'turn-completed');
    assert.equal(
      events.filter((e) => e.type.startsWith('turn-')).length,
      1,
      'exactly one terminal event per turn',
    );

    const cp = await stub.exportCheckpoint(s.sessionId);
    assert.equal(cp.adapter, 'stub');
    assert.equal(cp.sessionRef, s.sessionId);
    await stub.closeSession(s.sessionId);
    await assert.rejects(stub.runTurn(s.sessionId, { prompt: 'p', tools: [] }), /unknown session/);

    const recovered = await stub.recoverSession(cp);
    assert.equal(recovered.resumed, true);
    const out2 = await stub.runTurn(recovered.sessionId, { prompt: 'p', tools: [] });
    assert.equal(out2.text, 'second', 'recovery continues the script — no restart, no skip');
    await stub.closeSession(recovered.sessionId);
  });

  it('codex: full session lifecycle against the fake app-server', async () => {
    const codex = fakeCodex('ok');
    const s = await codex.startSession();
    assert.equal(s.sessionId, 'thread-fake-1');

    const out = await codex.runTurn(s.sessionId, { prompt: 'say hi', tools: ['read'] });
    assert.equal(out.text, 'First line\nSecond line');
    assert.deepEqual(out.toolCalls, [], 'codex tool calls are observed actions, never re-executable');
    assert.equal(out.actions?.length, 1);

    const events = await collectEvents(codex.streamEvents(s.sessionId));
    const terminals = events.filter((e) => e.type.startsWith('turn-'));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].type, 'turn-completed');
    assert.equal(events[events.length - 1], terminals[0], 'terminal event is last');
    assert.ok(events.some((e) => e.type === 'text'));
    assert.ok(events.some((e) => e.type === 'action'));

    const cp = await codex.exportCheckpoint(s.sessionId);
    assert.equal(cp.adapter, 'codex');
    assert.equal(cp.sessionRef, 'thread-fake-1');
    await codex.closeSession(s.sessionId);
    await assert.rejects(
      codex.runTurn(s.sessionId, { prompt: 'p', tools: [] }),
      (err: unknown) => err instanceof CodexAdapterError && /unknown session/.test((err as Error).message),
    );

    const recovered = await codex.recoverSession(cp);
    assert.equal(recovered.resumed, true);
    assert.equal(recovered.sessionId, 'thread-fake-1', 'thread/resume reattaches the same thread');
    const out2 = await codex.runTurn(recovered.sessionId, { prompt: 'again', tools: [] });
    assert.equal(out2.text, 'First line\nSecond line');
    await codex.closeSession(recovered.sessionId);
  });

  it('streamEvents on a session with no turn completes empty (both adapters)', async () => {
    const stub = new StubAdapter([]);
    const ss = await stub.startSession();
    assert.deepEqual(await collectEvents(stub.streamEvents(ss.sessionId)), []);
    await stub.closeSession(ss.sessionId);

    const codex = fakeCodex('ok');
    const cs = await codex.startSession();
    assert.deepEqual(await collectEvents(codex.streamEvents(cs.sessionId)), []);
    await codex.closeSession(cs.sessionId);
  });

  it('recoverSession refuses a checkpoint from another adapter (both adapters)', async () => {
    const stub = new StubAdapter([]);
    const foreign = { adapter: 'codex', version: 1 as const, sessionRef: 'x', exportedAt: 0, data: {} };
    await assert.rejects(
      stub.recoverSession(foreign),
      (err: unknown) => err instanceof AdapterUnsupportedError,
    );
    const codex = fakeCodex('ok');
    await assert.rejects(
      codex.recoverSession({ ...foreign, adapter: 'stub' }),
      (err: unknown) => err instanceof AdapterUnsupportedError,
    );
  });
});

describe('§26.2 adapter contract — cancellation truth', () => {
  it('codex: cancelTurn with no turn in flight is an error, never a fake cancel', async () => {
    const codex = fakeCodex('ok');
    const s = await codex.startSession();
    await assert.rejects(
      codex.cancelTurn(s.sessionId),
      (err: unknown) =>
        err instanceof CodexAdapterError && /no turn in flight/.test((err as Error).message),
    );
    await codex.closeSession(s.sessionId);
  });

  it('codex: cancelling an in-flight turn is provider-confirmed (hang scenario)', async () => {
    const codex = fakeCodex('hang');
    const s = await codex.startSession();
    const turnPromise = codex.runTurn(s.sessionId, { prompt: 'long', tools: [] });
    // Attach the rejection expectation before cancelling.
    const rejection = assert.rejects(
      turnPromise,
      (err: unknown) => err instanceof AdapterTurnCancelledError,
    );
    await sleep(300); // let turn/start land so a turn is actually in flight
    await codex.cancelTurn(s.sessionId); // resolves only on the server's interrupted event
    await rejection;
    await codex.closeSession(s.sessionId);
  });
});
