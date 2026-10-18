/**
 * scrubErrorText unit tests (H2 P3: error-log export redaction).
 * node:test + node:assert/strict. Run: node --test apps/desktop/tests/unit/scrub.test.mjs
 * (also runs as phase 1 of `npm run test:desktop`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scrubErrorText } = await import('../../src/utils/scrub.ts');

test('redacts Bearer tokens', () => {
  const out = scrubErrorText('fetch failed, Authorization: Bearer abcDEF123._-~+/==');
  assert.ok(!out.includes('abcDEF123'), `leaked: ${out}`);
  assert.ok(out.includes('Bearer [REDACTED]'), `unexpected: ${out}`);
});

test('redacts token=/apiKey:/secret=/password= assignments', () => {
  const cases = [
    ['request failed token=supersecret123', 'token=[REDACTED]'],
    ['config apiKey: "AK-999-xyz"', 'apiKey: "[REDACTED]'],
    ["login secret='hunter2hunter2'", "secret='[REDACTED]"],
    ['auth failed password=p@ssw0rd!', 'password=[REDACTED]'],
    ['refresh_token=rt-abc-123', 'refresh_token=[REDACTED]'],
  ];
  for (const [input, needle] of cases) {
    const out = scrubErrorText(input);
    assert.ok(out.includes(needle), `input=${input} => ${out}`);
  }
});

test('redacts well-known provider key formats', () => {
  const out = scrubErrorText(
    'keys sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_abcdefghijklmnopqrstuvwxyz123456 leaked',
  );
  assert.ok(!out.includes('sk-abcdefgh'), `leaked: ${out}`);
  assert.ok(!out.includes('ghp_abcdef'), `leaked: ${out}`);
  assert.ok(out.includes('sk-[REDACTED]'), `unexpected: ${out}`);
  assert.ok(out.includes('ghp_[REDACTED]'), `unexpected: ${out}`);

  const out2 = scrubErrorText('slack xoxb-123456789012-abcdef and aws AKIAIOSFODNN7EXAMPLE');
  assert.ok(!out2.includes('xoxb-123'), `leaked: ${out2}`);
  assert.ok(!out2.includes('AKIAIOSFODNN7EXAMPLE'), `leaked: ${out2}`);
});

test('leaves ordinary error text untouched', () => {
  const plain = 'TypeError: Cannot read properties of undefined (reading \'map\')\n    at App.tsx:42:10';
  assert.equal(scrubErrorText(plain), plain);
  assert.equal(scrubErrorText(''), '');
  assert.equal(scrubErrorText('no secrets here, just a 404'), 'no secrets here, just a 404');
});

test('is a pure function (no input mutation, deterministic)', () => {
  const input = 'boom token=abc123';
  const a = scrubErrorText(input);
  const b = scrubErrorText(input);
  assert.equal(a, b);
  assert.equal(input, 'boom token=abc123');
  assert.ok(a.includes('token=[REDACTED]'));
});
