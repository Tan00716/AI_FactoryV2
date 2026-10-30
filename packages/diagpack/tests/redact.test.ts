/**
 * diagpack redaction tests (V3-#10).
 * Fixtures are synthetic secret SHAPES (not real credentials) used to
 * prove the shared-pattern redaction + self-check. Run compiled:
 *   node --test packages/diagpack/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, selfCheckSecretPatterns, maskValue } from '../src/redact.js';

const GHP = 'ghp_' + 'a'.repeat(36);
const SK_LIVE = 'sk_live_' + 'b'.repeat(24);
const AWS_KEY = 'AKIA' + 'C'.repeat(16);
const JWT = 'eyJ' + 'x'.repeat(10) + '.eyJ' + 'y'.repeat(10) + '.sig' + 'z'.repeat(10);
const PRIVKEY = '-----BEGIN RSA PRIVATE KEY-----';

test('specific shapes are replaced wholesale, never partially leaked', () => {
  const text = `token ${GHP} and ${SK_LIVE} and ${AWS_KEY} and ${JWT} and ${PRIVKEY}`;
  const out = redactText(text);
  for (const raw of [GHP, SK_LIVE, AWS_KEY, JWT, PRIVKEY]) {
    assert.ok(!out.includes(raw), `raw value leaked: ${raw.slice(0, 8)}...`);
    assert.ok(!out.includes(raw.slice(0, 8)), 'prefix leaked');
  }
  assert.ok(out.includes('[REDACTED:github-pat-classic]'));
  assert.ok(out.includes('[REDACTED:stripe-live-key]'));
  assert.ok(out.includes('[REDACTED:aws-access-key]'));
  assert.ok(out.includes('[REDACTED:jwt-token]'));
  assert.ok(out.includes('[REDACTED:private-key]'));
  assert.deepEqual(selfCheckSecretPatterns(out), []);
});

test('generic assignment shapes keep the key name, mask only the value', () => {
  const out = redactText('config api_key=supersecretvalue123 password="hunter2hunter2" done');
  assert.ok(out.includes('api_key='), 'key name must survive for diagnostics');
  assert.ok(!out.includes('supersecretvalue123'));
  assert.ok(!out.includes('hunter2hunter2'));
  assert.ok(out.includes('password='));
  assert.deepEqual(selfCheckSecretPatterns(out), []);
});

test('bearer, basic-auth-url and db connection strings are removed wholesale', () => {
  const text = 'Authorization: "Bearer abcdefghijklmnop123456" and postgres://user:s3cretpass@db.local/x and https://user:s3cretpass@host/path';
  const out = redactText(text);
  assert.ok(!out.includes('abcdefghijklmnop123456'));
  assert.ok(!out.includes('s3cretpass'));
  assert.deepEqual(selfCheckSecretPatterns(out), []);
});

test('self-check flags raw fixture text and passes clean text', () => {
  assert.ok(selfCheckSecretPatterns(`key ${GHP}`).includes('github-pat-classic'));
  assert.deepEqual(selfCheckSecretPatterns('nothing secret here, just words'), []);
});

test('maskValue follows the shared convention (first 4 + last 2)', () => {
  assert.equal(maskValue('abcdefghij'), 'abcd…ij');
});

test('plain diagnostic text passes through untouched', () => {
  const text = 'server boot ok, 12 projects, egress enabled, default deny';
  assert.equal(redactText(text), text);
});
