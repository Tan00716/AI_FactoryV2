/**
 * OS keychain backend — modeled + probed. No live keyring exists on
 * the dev machine, so behavior is pinned through an injected fake
 * command runner: argument construction, stdin value delivery,
 * miss-vs-failure handling, and platform detection. NOTHING here
 * claims a real keyring was exercised.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeychainStore,
  SecretBackendUnavailableError,
  probeKeychainSync,
  type KeychainCommandRunner,
} from '../src/index';

interface Call { file: string; args: string[]; input?: string }

function fakeRunner(behavior: (call: Call) => { stdout: string }) {
  const calls: Call[] = [];
  const runner: KeychainCommandRunner = async (file, args, input) => {
    const call = { file, args, input };
    calls.push(call);
    return behavior(call);
  };
  return { runner, calls };
}

function exitError(code: number | string): Error {
  const e = new Error(`exit ${code}`) as Error & { code: unknown };
  e.code = code;
  return e;
}

const FOUND = { available: true, platform: 'linux', tool: 'secret-tool', reason: 'fake' } as const;

describe('probeKeychainSync', () => {
  it('reports available when `which` finds the tool', () => {
    const d = probeKeychainSync('linux', () => '/usr/bin/secret-tool\n');
    assert.equal(d.available, true);
    assert.equal(d.tool, 'secret-tool');
  });

  it('reports unavailable (with reason) when the tool is missing', () => {
    const d = probeKeychainSync('linux', () => { throw new Error('not found'); });
    assert.equal(d.available, false);
    assert.match(d.reason, /secret-tool not found/);
  });

  it('win32/cmdkey is honestly unavailable for reads', () => {
    const d = probeKeychainSync('win32', () => { throw new Error('should not probe'); });
    assert.equal(d.available, false);
    assert.equal(d.tool, 'cmdkey');
    assert.match(d.reason, /cannot read a password back/);
  });
});

describe('KeychainStore (linux / secret-tool, fake runner)', () => {
  it('lookup builds the right argv and returns stdout', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'the-value\n' }));
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    assert.equal(await store.get('github-token'), 'the-value');
    assert.deepEqual(calls[0].args, ['lookup', 'service', 'ai-factory', 'name', 'github-token']);
  });

  it('a non-zero lookup exit is a clean miss → undefined', async () => {
    const { runner } = fakeRunner(() => { throw exitError(1); });
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    assert.equal(await store.get('absent'), undefined);
  });

  it('a spawn failure (ENOENT) is unavailable, NOT a miss', async () => {
    const { runner } = fakeRunner(() => { throw exitError('ENOENT'); });
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    await assert.rejects(() => store.get('k'), SecretBackendUnavailableError);
  });

  it('store delivers the value on stdin, never in argv', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: '' }));
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    await store.set('api-key', 'do-not-put-me-in-argv');
    assert.equal(calls[0].input, 'do-not-put-me-in-argv');
    assert.ok(!calls[0].args.join(' ').includes('do-not-put-me-in-argv'));
    assert.deepEqual(calls[0].args.slice(0, 1), ['store']);
  });

  it('delete checks existence first and clears by attributes', async () => {
    const { runner, calls } = fakeRunner((call) =>
      call.args[0] === 'lookup' ? { stdout: 'v' } : { stdout: '' });
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    assert.equal(await store.delete('api-key'), true);
    assert.ok(calls.some((c) => c.args[0] === 'clear'));
    const { runner: runner2 } = fakeRunner(() => { throw exitError(1); });
    const store2 = new KeychainStore({ platform: 'linux', runner: runner2, detection: { ...FOUND } });
    assert.equal(await store2.delete('absent'), false);
  });

  it('an unavailable detection makes every operation fail loudly', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '' }));
    const store = new KeychainStore({
      platform: 'linux',
      runner,
      detection: { available: false, platform: 'linux', tool: 'secret-tool', reason: 'secret-tool not found on PATH' },
    });
    assert.equal(store.writable, false);
    await assert.rejects(() => store.get('k'), /secret-tool not found/);
    await assert.rejects(() => store.set('k', 'v'), SecretBackendUnavailableError);
  });

  it('cannot enumerate: list() is empty by design', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '' }));
    const store = new KeychainStore({ platform: 'linux', runner, detection: { ...FOUND } });
    assert.deepEqual(await store.list(), []);
  });
});

describe('KeychainStore (darwin / security, fake runner)', () => {
  it('uses generic-password argv shapes', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'mac-value\n' }));
    const store = new KeychainStore({
      platform: 'darwin',
      runner,
      detection: { available: true, platform: 'darwin', tool: 'security', reason: 'fake' },
    });
    assert.equal(await store.get('k'), 'mac-value');
    assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'ai-factory', '-a', 'k', '-w']);
  });
});
