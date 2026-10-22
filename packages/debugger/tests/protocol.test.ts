/**
 * DebugClient protocol tests against the fake DAP adapter fixture.
 *
 * Record/replay style: the full DAP message sequence of a debug session is
 * exercised end to end (initialize → launch → breakpoints → stopped →
 * stack/scopes/variables → step → evaluate → disconnect), plus the
 * fail-closed paths (spawn failure, early adapter exit, request timeout,
 * adapter-reported error).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DebugClient, DebugError, SpawnedProcess } from '../src/index';
import { EventEmitter } from 'node:events';

// Compiled CJS layout: dist/tests/<this>.test.js, fixtures copied to dist/tests/fixtures by the build script.
const FAKE_ADAPTER = join(__dirname, 'fixtures', 'fake-adapter.mjs');

/** Collect DAP event names in arrival order. */
function recordEvents(client: DebugClient): string[] {
  const names: string[] = [];
  for (const e of ['initialized', 'stopped', 'continued', 'terminated', 'exited', 'output', 'breakpoint']) {
    client.on(e, () => names.push(e));
  }
  return names;
}

describe('DebugClient against fake adapter', () => {
  it('runs the full session message sequence', async () => {
    const client = new DebugClient(FAKE_ADAPTER);
    const events = recordEvents(client);
    await client.start();
    const caps = await client.initialize();
    assert.equal(caps.supportsConfigurationDoneRequest, true);
    await client.launch({ program: '/tmp/fake-target.mjs' });
    assert.ok(events.includes('initialized'), 'expected initialized event');

    const bps = await client.setBreakpoints({ path: '/tmp/fake-target.mjs' }, [{ line: 2 }]);
    assert.equal(bps.length, 1);
    assert.equal(bps[0].verified, true);
    assert.equal(bps[0].line, 2);

    const stoppedAt = new Promise((resolve) => client.on('stopped', resolve));
    await client.configurationDone();
    const stopped = (await stoppedAt) as { reason: string; threadId: number };
    assert.equal(stopped.reason, 'breakpoint');

    const threads = await client.threads();
    assert.deepEqual(threads, [{ id: 1, name: 'main' }]);

    const stack = await client.stackTrace(1);
    assert.equal(stack.totalFrames, 1);
    assert.equal(stack.stackFrames[0].name, 'compute');
    assert.equal(stack.stackFrames[0].line, 2);

    const scopes = await client.scopes(1);
    assert.equal(scopes[0].name, 'Local');
    assert.ok(scopes[0].variablesReference > 0);

    const vars = await client.variables(scopes[0].variablesReference);
    assert.deepEqual(vars.map((v) => [v.name, v.value]), [['n', '21']]);

    const stepped = new Promise((resolve) => client.on('stopped', resolve));
    await client.next(1);
    const steppedBody = (await stepped) as { reason: string };
    assert.equal(steppedBody.reason, 'step');

    const evaled = await client.evaluate('n + 1');
    assert.equal(evaled.result, '22');

    await client.disconnect(true);
    await client.stop();
    assert.ok(events.includes('terminated'), `events seen: ${events.join(',')}`);
  });

  it('surfaces adapter-reported errors as DAP_ERROR', async () => {
    const client = new DebugClient(FAKE_ADAPTER);
    await client.start();
    await client.initialize();
    await assert.rejects(client.variables(999), (e: unknown) => {
      assert.ok(e instanceof DebugError);
      assert.equal((e as DebugError).code, 'DAP_ERROR');
      return true;
    });
    await assert.rejects(client.evaluate('nope'), /boom/);
    await client.stop();
  });

  it('fails closed when the adapter exits early', async () => {
    // Deterministic: the spawn holds for a tick (start resolves), then the
    // adapter dies — late requests must reject with ADAPTER_EXITED.
    const emitter = new EventEmitter();
    let exitCb: ((code: unknown) => void) | null = null;
    const fake: SpawnedProcess = {
      stdin: { write: () => true } as unknown as SpawnedProcess['stdin'],
      stdout: new EventEmitter() as unknown as SpawnedProcess['stdout'],
      stderr: new EventEmitter() as unknown as SpawnedProcess['stderr'],
      on: (ev: 'error' | 'exit', cb: (...a: unknown[]) => void) => {
        if (ev === 'exit') exitCb = cb as (code: unknown) => void;
        void emitter.on(ev, cb);
      },
      kill: () => undefined,
    };
    const client = new DebugClient('/fake.js', { spawnFn: () => fake });
    await client.start();
    assert.equal(client.exited, false);
    assert.ok(exitCb, 'expected an exit listener');
    (exitCb as (code: unknown) => void)(0);
    assert.equal(client.exited, true);
    await assert.rejects(client.threads(), (e: unknown) => {
      assert.equal((e as DebugError).code, 'ADAPTER_EXITED');
      return true;
    });
    await client.stop();
  });

  it('fails closed when the adapter cannot spawn', async () => {
    const badSpawn = (): SpawnedProcess => {
      throw new Error('ENOENT');
    };
    const client = new DebugClient('/nonexistent/adapter.js', { spawnFn: badSpawn });
    await assert.rejects(client.start(), (e: unknown) => {
      assert.equal((e as DebugError).code, 'ADAPTER_SPAWN_FAILED');
      return true;
    });
  });

  it('times out a request that never answers (DAP_TIMEOUT)', async () => {
    const emitter = new EventEmitter();
    const fake: SpawnedProcess = {
      stdin: { write: () => true } as unknown as SpawnedProcess['stdin'],
      stdout: new EventEmitter() as unknown as SpawnedProcess['stdout'],
      stderr: new EventEmitter() as unknown as SpawnedProcess['stderr'],
      on: (ev: 'error' | 'exit', cb: (...a: unknown[]) => void) => void emitter.on(ev, cb),
      kill: () => undefined,
    };
    const client = new DebugClient('/fake.js', {
      spawnFn: () => fake,
      requestTimeoutMs: 100,
    });
    await client.start();
    await assert.rejects(client.threads(), (e: unknown) => {
      assert.equal((e as DebugError).code, 'DAP_TIMEOUT');
      return true;
    });
    await client.stop();
  });

  it('scrubs NODE_TEST_CONTEXT from the spawned adapter env', async () => {
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    process.env.NODE_TEST_WORKER_ID = '7';
    let seenEnv: Record<string, string> | null = null;
    const emitter = new EventEmitter();
    const fake: SpawnedProcess = {
      stdin: { write: () => true } as unknown as SpawnedProcess['stdin'],
      stdout: new EventEmitter() as unknown as SpawnedProcess['stdout'],
      stderr: new EventEmitter() as unknown as SpawnedProcess['stderr'],
      on: (ev: 'error' | 'exit', cb: (...a: unknown[]) => void) => void emitter.on(ev, cb),
      kill: () => undefined,
    };
    const client = new DebugClient('/fake.js', {
      spawnFn: (cmd, args, opts) => {
        seenEnv = opts.env;
        return fake;
      },
      requestTimeoutMs: 50,
    });
    try {
      await client.start();
    } catch {
      /* may time out later — we only care about the env */
    }
    assert.ok(seenEnv);
    assert.equal((seenEnv as Record<string, string>).NODE_TEST_CONTEXT, undefined);
    assert.equal((seenEnv as Record<string, string>).NODE_TEST_WORKER_ID, undefined);
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_WORKER_ID;
    await client.stop();
  });
});
