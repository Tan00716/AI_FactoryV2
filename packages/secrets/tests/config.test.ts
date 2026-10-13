/**
 * Factory (config.ts): backend selection, chain shape, the
 * FACTORY_SECRETS_* (config) vs FACTORY_SECRET_<NAME> (values)
 * disambiguation, and keychain fail-closed startup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretBackendUnavailableError,
  createSecretBrokerFromEnv,
  probeKeychainSync,
} from '../src/index';

describe('createSecretBrokerFromEnv', () => {
  it('memory backend: chain is [memory, env]', async () => {
    const setup = createSecretBrokerFromEnv({
      env: { FACTORY_SECRETS_BACKEND: 'memory', FACTORY_SECRET_FROM_ENV: 'env-value' },
    });
    assert.equal(setup.backend, 'memory');
    assert.deepEqual(setup.chain, ['memory', 'env']);
    await setup.broker.set('written', 'v1', { actor: 't' });
    assert.equal(await setup.broker.resolve('written', { actor: 't' }), 'v1');
    assert.equal(await setup.broker.resolve('from-env', { actor: 't' }), 'env-value');
  });

  it('config vars (plural) never collide with secret names (singular prefix)', async () => {
    // FACTORY_SECRET_BACKEND is, to the env backend, simply the secret
    // named "backend" — the broker's own config lives under
    // FACTORY_SECRETS_* and must not appear as phantom secrets.
    const setup = createSecretBrokerFromEnv({
      env: {
        FACTORY_SECRETS_BACKEND: 'memory',
        FACTORY_SECRET_BACKEND: 'the-secret-named-backend',
      },
    });
    assert.equal(await setup.broker.resolve('backend', { actor: 't' }), 'the-secret-named-backend');
    const names = (await setup.broker.list()).map((m) => m.name);
    assert.deepEqual(names, ['backend']);
  });

  it('file backend: vault paths derive from FACTORY_SECRETS_DIR and persist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-config-'));
    try {
      const env = { FACTORY_SECRETS_BACKEND: 'file', FACTORY_SECRETS_DIR: join(dir, 'vault') };
      const a = createSecretBrokerFromEnv({ env });
      assert.equal(a.backend, 'file-vault');
      assert.ok(a.vaultPath?.endsWith(join('vault', 'vault.json')));
      assert.ok(a.keyPath?.endsWith(join('vault', 'vault.key')));
      await a.broker.set('persisted', 'v', { actor: 't' });
      const b = createSecretBrokerFromEnv({ env });
      assert.equal(await b.broker.resolve('persisted', { actor: 't' }), 'v');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env backend alone: chain is just [env] and writes refuse', async () => {
    const setup = createSecretBrokerFromEnv({ env: { FACTORY_SECRETS_BACKEND: 'env' } });
    assert.deepEqual(setup.chain, ['env']);
    await assert.rejects(() => setup.broker.set('k', 'v', { actor: 't' }), /no writable secret backend/);
  });

  it('unknown backend value is a startup error, not a fallback', () => {
    assert.throws(
      () => createSecretBrokerFromEnv({ env: { FACTORY_SECRETS_BACKEND: 'dropbox' } }),
      SecretBackendUnavailableError,
    );
  });

  it('keychain backend with no keychain tool throws (§46.2 no silent downgrade)', () => {
    if (probeKeychainSync().available) return; // a real keyring exists here — nothing to assert
    assert.throws(
      () => createSecretBrokerFromEnv({ env: { FACTORY_SECRETS_BACKEND: 'keychain' } }),
      SecretBackendUnavailableError,
    );
  });
});
