/**
 * Env backend: FACTORY_SECRET_<NAME> mapping, canonical listing,
 * read-only surface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnvSecretStore, SecretBroker, envVarForSecret } from '../src/index';

describe('EnvSecretStore', () => {
  it('maps names to FACTORY_SECRET_* variables', () => {
    assert.equal(envVarForSecret('github-token'), 'FACTORY_SECRET_GITHUB_TOKEN');
    assert.equal(envVarForSecret('my.db.key'), 'FACTORY_SECRET_MY_DB_KEY');
    assert.equal(envVarForSecret('a'), 'FACTORY_SECRET_A');
  });

  it('resolves values; unset and empty both mean missing', async () => {
    const store = new EnvSecretStore({
      FACTORY_SECRET_GITHUB_TOKEN: 'ghp_example',
      FACTORY_SECRET_EMPTY: '',
    });
    assert.equal(await store.get('github-token'), 'ghp_example');
    assert.equal(await store.get('github.token'), 'ghp_example'); // same canonical var
    assert.equal(await store.get('empty'), undefined);
    assert.equal(await store.get('absent'), undefined);
  });

  it('lists canonical names derived from the environment', async () => {
    const store = new EnvSecretStore({
      FACTORY_SECRET_GITHUB_TOKEN: 'x',
      FACTORY_SECRET_MY_DB_KEY: 'y',
      FACTORY_API_TOKEN: 'not-a-secret-backend-entry',
      OTHER: 'z',
    });
    assert.deepEqual(await store.list(), ['github-token', 'my-db-key']);
  });

  it('is read-only: no set/delete surface at all', () => {
    const store = new EnvSecretStore({});
    assert.equal(store.writable, false);
    const asRecord = store as unknown as Record<string, unknown>;
    assert.equal(asRecord['set'], undefined);
    assert.equal(asRecord['delete'], undefined);
  });

  it('works inside a broker chain as the fallback resolver', async () => {
    const broker = new SecretBroker({
      stores: [new EnvSecretStore({ FACTORY_SECRET_ONLY_ENV: 'env-value' })],
    });
    assert.equal(await broker.resolve('only-env', { actor: 't' }), 'env-value');
    const meta = await broker.describe('only-env');
    assert.equal(meta.backend, 'env');
  });
});
