/** redactSecrets / redactText tests — spec §68 (no credentials in traces). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactText, REDACTED } from '../src/index.js';

describe('redactSecrets', () => {
  it('replaces sensitive top-level values with ***', () => {
    const out = redactSecrets({ user: 'tan', password: 'hunter2', api_key: 'sk-abc' });
    assert.equal(out.user, 'tan');
    assert.equal(out.password, REDACTED);
    assert.equal(out.api_key, REDACTED);
  });

  it('is case-insensitive and matches nested structures and arrays', () => {
    const out = redactSecrets({
      config: { AuthToken: 'tok', nested: { DB_PASSWORD: 'pw' } },
      items: [{ secret: 's' }, { ok: 1 }],
    });
    assert.equal(out.config.AuthToken, REDACTED);
    assert.equal(out.config.nested.DB_PASSWORD, REDACTED);
    assert.equal(out.items[0].secret, REDACTED);
    assert.equal(out.items[1].ok, 1);
  });

  it('leaves non-sensitive data untouched and does not mutate input', () => {
    const input = { model: 'code-coder', cost: 3, tags: ['a'] };
    const out = redactSecrets(input);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
    assert.equal(input.model, 'code-coder');
  });

  it('redacts non-string sensitive values too', () => {
    const out = redactSecrets({ credentials: { user: 'u', pass: 'p' }, count: 2 });
    // 'credentials' itself is a sensitive key → whole subtree replaced.
    assert.equal(out.credentials, REDACTED);
    assert.equal(out.count, 2);
  });
});

describe('redactText', () => {
  it('masks key=value pairs with sensitive keys', () => {
    const s = redactText('connect with api_key=sk-live-123 and user=tan');
    assert.ok(s.includes('api_key=' + REDACTED));
    assert.ok(s.includes('user=tan'));
    assert.ok(!s.includes('sk-live-123'));
  });
});
