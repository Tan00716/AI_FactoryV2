/**
 * scrubCredentialEnv — H4 audit: child processes must not inherit the
 * server's own credential env vars (FACTORY_API_TOKEN[S],
 * FACTORY_SECRET_*). Run: node --test dist/tests/scrub-credential-env.test.js
 * (after tsc -p tsconfig.json).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubCredentialEnv } from '../src/pty';

describe('scrubCredentialEnv', () => {
  it('removes the API token vars and every FACTORY_SECRET_* var', () => {
    const out = scrubCredentialEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      DB_PATH: '/data/factory.db',
      FACTORY_API_TOKEN: 'admin-token',
      FACTORY_API_TOKENS: 'viewer:a,admin:b',
      FACTORY_SECRET_GITHUB_TOKEN: 'ghp_real',
      FACTORY_SECRET_API_KEY: 'sk-real',
    });
    assert.deepEqual(out, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DB_PATH: '/data/factory.db',
    });
  });

  it('does not mutate its input', () => {
    const input = { FACTORY_API_TOKEN: 'x', PATH: '/bin' };
    scrubCredentialEnv(input);
    assert.deepEqual(input, { FACTORY_API_TOKEN: 'x', PATH: '/bin' });
  });

  it('keeps backend config and similarly-named non-credential vars', () => {
    const out = scrubCredentialEnv({
      FACTORY_SECRETS_DIR: '/data/secrets',
      FACTORY_SECRETS_BACKEND: 'file',
      FACTORY_API_TOKEN_TTL: '3600',
    });
    // None of these are credential values: the backend dir/config and a
    // hypothetical TTL var must survive (exact/prefix discipline).
    assert.deepEqual(out, {
      FACTORY_SECRETS_DIR: '/data/secrets',
      FACTORY_SECRETS_BACKEND: 'file',
      FACTORY_API_TOKEN_TTL: '3600',
    });
  });
});
