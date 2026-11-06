/**
 * ambientCredentialValues / redactAmbientCredentialValues /
 * stripControlPlanePointerEnv — V3.0 audit round 17, item #6
 * sub-items (h) value-aware redaction and (k) control-plane pointer
 * stripping.
 *
 * Run: node --test dist/tests/ambient-credentials.test.js
 * (after tsc -p tsconfig.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ambientCredentialValues,
  redactAmbientCredentialValues,
  stripControlPlanePointerEnv,
} from '../src/ambient-credentials';

const TOKEN_VALUE = 'test-token-abcdef-1234567890';
const SECRET_VALUE = 'test-secret-abcdef-1234567890';

test('V3R17 #6(h): ambientCredentialValues is exactly the scrubbed set; redaction replaces values', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    HOME: '/home/u',
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_API_TOKENS: 'viewer:a,admin:b-long-enough-value',
    FACTORY_SECRET_PROBE: SECRET_VALUE,
    AI_FACTORY_TOKEN: 'test-ai-factory-token-1234567890',
    FACTORY_PRLINK_TOKEN: 'test-prlink-token-1234567890',
    FACTORY_WEBHOOK_SECRET: 'test-webhook-secret-1234567890',
    FACTORY_SECRET_TINY: 'abc12',
  };
  const values = ambientCredentialValues(env);
  // The scrubbed set: every long credential value (including the R17
  // #6(j) additions), nothing else.
  for (const v of [
    TOKEN_VALUE,
    'viewer:a,admin:b-long-enough-value',
    SECRET_VALUE,
    'test-ai-factory-token-1234567890',
    'test-prlink-token-1234567890',
    'test-webhook-secret-1234567890',
  ]) {
    assert.ok(values.includes(v), `missing credential value ${v}`);
  }
  assert.ok(!values.includes('/usr/bin:/bin:/usr/local/bin'), 'benign PATH value must not be redacted');
  assert.ok(!values.includes('abc12'), 'short values (< 8 chars) are never redacted');
  // Value-aware redaction: values gone, key names + surrounding text
  // intact (the secret is the value; redactors replace values, not
  // key names — the echoed line reads KEY=***).
  const text = `before FACTORY_API_TOKEN=${TOKEN_VALUE} middle FACTORY_SECRET_PROBE=${SECRET_VALUE} after`;
  const redacted = redactAmbientCredentialValues(text, env);
  assert.ok(!redacted.includes(TOKEN_VALUE), 'token value leaked');
  assert.ok(!redacted.includes(SECRET_VALUE), 'secret value leaked');
  assert.ok(redacted.includes('FACTORY_API_TOKEN=***'), 'redaction marker expected on the assignment line');
  assert.ok(redacted.includes('FACTORY_SECRET_PROBE=***'), 'redaction marker expected on the secret line');
  assert.ok(redacted.startsWith('before ') && redacted.endsWith(' after'), 'surrounding text must survive');
  // No credential values at all: the text passes through untouched.
  assert.equal(redactAmbientCredentialValues('plain output, nothing secret', {}), 'plain output, nothing secret');
});

test('V3R17 #6(k): stripControlPlanePointerEnv removes pointer vars only', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: '/srv/data/secrets',
    FACTORY_API_TOKEN_FILE: '/srv/data/token.txt',
    DB_PATH: '/srv/data/factory.db',
    AI_FACTORY_DATA_DIR: '/srv/data',
    FACTORY_PRLINK_TOKEN_FILE: '/srv/data/prlink.txt',
    FACTORY_WEBHOOK_SECRET_FILE: '/srv/data/webhook.txt',
  };
  const stripped = stripControlPlanePointerEnv(env);
  for (const k of [
    'FACTORY_SECRETS_DIR',
    'FACTORY_API_TOKEN_FILE',
    'DB_PATH',
    'AI_FACTORY_DATA_DIR',
    'FACTORY_PRLINK_TOKEN_FILE',
    'FACTORY_WEBHOOK_SECRET_FILE',
  ]) {
    assert.ok(!(k in stripped), `${k} must be stripped`);
  }
  // The strip is about pointers, not values: the credential itself and
  // benign vars survive (the scrub is what removes credentials).
  assert.equal(stripped['FACTORY_API_TOKEN'], TOKEN_VALUE);
  assert.equal(stripped['PATH'], '/usr/bin');
  // The input is not mutated.
  assert.equal(env['DB_PATH'], '/srv/data/factory.db');
  assert.equal(env['FACTORY_SECRETS_DIR'], '/srv/data/secrets');
});
