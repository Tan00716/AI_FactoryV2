import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretRef,
  isSecretRef,
  redactSecrets,
  redactDeep,
  createRedactingAudit,
} from '../src/index';

describe('SecretRef', () => {
  it('stores only a reference, exposes secret://name', () => {
    const s = SecretRef.create('openai-key');
    assert.equal(s.ref, 'secret://openai-key');
    assert.equal(s.name, 'openai-key');
  });

  it('never leaks via toString / template interpolation', () => {
    const s = SecretRef.create('openai-key');
    assert.equal(String(s), '***');
    assert.equal(`key=${s}`, 'key=***');
  });

  it('never leaks via JSON.stringify', () => {
    const s = SecretRef.create('db-pass');
    const json = JSON.stringify({ secret: s });
    assert.ok(!json.includes('db-pass') || json.includes('secret://db-pass'));
    assert.ok(json.includes('secret://db-pass'));
    assert.ok(!json.includes('hunter2'));
  });

  it('rejects invalid secret names', () => {
    assert.throws(() => SecretRef.create(''), /invalid secret name/);
    assert.throws(() => SecretRef.create('../etc/passwd'), /invalid secret name/);
  });

  it('derefs only through a caller-supplied resolver, throws when missing', () => {
    const s = SecretRef.create('k');
    assert.equal(s.deref(() => 'transient-value'), 'transient-value');
    assert.throws(() => s.deref(() => undefined), /secret not found/);
  });

  it('isSecretRef distinguishes references from plaintext', () => {
    assert.equal(isSecretRef('secret://openai-key'), true);
    assert.equal(isSecretRef('sk-abc123'), false);
    assert.equal(isSecretRef('secret://'), false);
  });
});

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys', () => {
    assert.equal(redactSecrets('key=sk-abcDEF1234567890xyz'), 'key=sk-***');
  });

  it('redacts GitHub tokens', () => {
    assert.equal(redactSecrets('token ghp_abcdefghijklmnop1234'), 'token ghp_***');
  });

  it('redacts AWS access key ids', () => {
    assert.equal(redactSecrets('AKIAIOSFODNN7EXAMPLE'), 'AKIA***');
  });

  it('redacts Bearer tokens', () => {
    assert.equal(redactSecrets('Authorization: Bearer eyJhbGciOi.abc-def_123'), 'Authorization: Bearer ***');
  });

  it('redacts password= assignments', () => {
    assert.equal(redactSecrets('db password=hunter2 ok'), 'db password=*** ok');
  });

  it('redacts api_key in JSON-ish text', () => {
    const out = redactSecrets('{"api_key": "sekrit-123"}');
    assert.ok(!out.includes('sekrit-123'));
    assert.ok(out.includes('api_key=***'));
  });

  it('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBsecret\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(pem);
    assert.ok(!out.includes('MIIBsecret'));
    assert.ok(out.includes('***'));
  });

  it('redacts passwords embedded in URLs', () => {
    assert.equal(redactSecrets('https://user:s3cr3t@host/db'), 'https://user:***@host/db');
  });

  it('leaves ordinary text untouched (no false positives)', () => {
    const text = 'deploy the model to staging and review the logs';
    assert.equal(redactSecrets(text), text);
  });

  it('preserves secret:// references (already the safe form)', () => {
    assert.equal(redactSecrets('use secret://openai-key'), 'use secret://openai-key');
  });

  it('is idempotent', () => {
    const once = redactSecrets('pw=hunter2 and sk-abcDEF1234567890');
    assert.equal(redactSecrets(once), once);
  });
});

describe('redactDeep', () => {
  it('redacts strings nested in objects and arrays', () => {
    const out = redactDeep({ a: ['pw=hunter2'], b: { c: 'sk-abcDEF1234567890' } }) as Record<string, unknown>;
    assert.equal((out['a'] as string[])[0], 'pw=***');
    assert.equal((out['b'] as Record<string, string>)['c'], 'sk-***');
  });

  it('redacts SecretRef instances', () => {
    assert.equal(redactDeep(SecretRef.create('k')), '***');
  });
});

describe('createRedactingAudit', () => {
  it('redacts details before the sink sees them', () => {
    const seen: unknown[] = [];
    const sink = {
      record(actor: string, action: string, t: string, id: string, details: Record<string, unknown> = {}) {
        seen.push({ actor, action, t, id, details });
        return { id };
      },
    };
    const audit = createRedactingAudit(sink);
    audit.record('agent-1', 'DEPLOY', 'task', 't1', { token: 'sk-abcDEF1234567890', note: 'fine' });
    const rec = seen[0] as { details: Record<string, string> };
    assert.equal(rec.details['token'], 'sk-***');
    assert.equal(rec.details['note'], 'fine');
  });
});
