/**
 * R4-S1 — pre-send prompt secret scanning.
 *
 * The choke point: every prompt handed to `adapter.invoke()` must pass
 * `assertPromptSafe` first. Block mode refuses the invoke (audit
 * PROMPT_SECRET_BLOCKED + HIGH notification via injected sinks, adapter
 * never invoked); redact mode releases a sanitized prompt.
 *
 * Fixtures use realistic-but-fake secrets. Nothing here is a real key.
 *
 * Run: node --test packages/runtime/dist/tests/pre-send-scan.test.js
 *        (after tsc -p packages/runtime/tsconfig.json)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  StubAdapter,
  scanPromptForSecrets,
  redactPromptSecrets,
  assertPromptSafe,
  PreSendSecretBlockedError,
  PRE_SEND_PATTERNS,
  setPreSendScanMode,
  getPreSendScanMode,
  setPreSendScanSinks,
} from '../src/index';

afterEach(() => {
  setPreSendScanMode('block');
  setPreSendScanSinks({});
  delete process.env.FACTORY_PRE_SEND_SCAN_MODE;
});

/** One true-positive sample per pattern family (all fake values). */
const TRUE_POSITIVES: Array<{ family: string; prompt: string; secret: string }> = [
  { family: 'aws-access-key', prompt: 'Deploy with key AKIAIOSFODNN7EXAMPLE today', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { family: 'aws-secret-key', prompt: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { family: 'github-pat-classic', prompt: 'Clone via https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com', secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
  { family: 'github-pat-fine-grained', prompt: `Use github_pat_${'a'.repeat(82)} for CI`, secret: `github_pat_${'a'.repeat(82)}` },
  { family: 'github-token', prompt: `Auth header gho_${'b'.repeat(36)}`, secret: `gho_${'b'.repeat(36)}` },
  { family: 'private-key', prompt: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...', secret: '-----BEGIN RSA PRIVATE KEY-----' },
  { family: 'slack-token', prompt: 'Notify slack with xoxb-1234567890-abcdefghij', secret: 'xoxb-1234567890-abcdefghij' },
  { family: 'slack-webhook', prompt: 'POST https://hooks.slack.com/services/TABCDEF12/BBCDEF1234/abcdefghijklmnopqrstuvwxyz', secret: 'TABCDEF12' },
  { family: 'stripe-live-key', prompt: 'Charge with sk_live_abcdefghijklmnop', secret: 'sk_live_abcdefghijklmnop' },
  { family: 'google-api-key', prompt: `Maps key AIza${'c'.repeat(35)}`, secret: `AIza${'c'.repeat(35)}` },
  { family: 'jwt-token', prompt: 'Verify eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', secret: 'eyJhbGciOiJIUzI1NiJ9' },
  { family: 'sendgrid-key', prompt: `Send via SG.${'d'.repeat(22)}.${'e'.repeat(43)}`, secret: `SG.${'d'.repeat(22)}` },
  { family: 'npm-token', prompt: `npm login npm_${'f'.repeat(36)}`, secret: `npm_${'f'.repeat(36)}` },
  { family: 'pypi-token', prompt: `Upload with pypi-${'g'.repeat(40)}`, secret: `pypi-${'g'.repeat(40)}` },
  { family: 'telegram-bot-token', prompt: `Bot token 123456789:${'h'.repeat(35)}`, secret: `123456789:${'h'.repeat(35)}` },
  { family: 'openai-key', prompt: `Model key sk-proj-${'i'.repeat(20)}`, secret: `sk-proj-${'i'.repeat(20)}` },
  { family: 'generic-api-key', prompt: 'Config: api_key = "supersecretvalue123"', secret: 'supersecretvalue123' },
  { family: 'generic-password', prompt: 'Login with password: "hunter22hunter"', secret: 'hunter22hunter' },
  { family: 'bearer-token', prompt: 'Authorization: "Bearer abcdefghijklmnop123"', secret: 'abcdefghijklmnop123' },
  { family: 'basic-auth-url', prompt: 'Pull from https://admin:s3cr3tpass@db.internal:5432/app', secret: 's3cr3tpass' },
  { family: 'db-connection-string', prompt: 'Connect postgres://admin:s3cr3tpass@db.internal:5432/app', secret: 's3cr3tpass' },
  { family: 'token-assignment', prompt: 'Rotate the leaked key; config has token = "abcdefghijklmnop1234"', secret: 'abcdefghijklmnop1234' },
  { family: 'secret-assignment', prompt: 'The webhook secret: "mysecret99value"', secret: 'mysecret99value' },
  { family: 'password-assignment', prompt: 'Reset with password=hunter22 now', secret: 'hunter22' },
];

/** Boundary samples that must NOT be flagged (false-positive discipline). */
const FALSE_POSITIVE_BOUNDARY: string[] = [
  'The token expired yesterday, please refresh it.',
  'My password is hunter2', // no assignment operator
  'Set your api_key = YOUR_KEY_HERE before running', // placeholder value
  'Contact admin@example.com for the AKIA documentation', // prefix only
  'Use sk-abc for local dev', // too short
  'Use Bearer <token> in the Authorization header', // angle-bracket placeholder
  'The database URL is postgres://localhost/mydb', // no credentials
  'token = abc', // value too short
  'example: api_key = "placeholder-value"', // placeholder word
  'Write a haiku about the sea.',
];

describe('pre-send secret scan: pattern coverage', () => {
  it('covers every pattern family in the pre-send engine', () => {
    const families = new Set(PRE_SEND_PATTERNS.map((p) => p.name));
    assert.equal(families.size, PRE_SEND_PATTERNS.length, 'pattern names must be unique');
    assert.equal(families.size, 24, '21 shared families + 3 prompt-shaped extras');
    for (const { family } of TRUE_POSITIVES) {
      assert.ok(families.has(family), `fixture family ${family} must exist in the pre-send engine`);
    }
  });

  for (const { family, prompt, secret } of TRUE_POSITIVES) {
    it(`detects ${family}`, () => {
      const found = scanPromptForSecrets(prompt);
      assert.ok(found.includes(family), `expected ${family} in [${found}]`);
    });

    it(`blocks ${family} without echoing the value`, () => {
      assert.throws(
        () => assertPromptSafe(prompt, { adapter: 'test' }),
        (err: unknown) => {
          assert.ok(err instanceof PreSendSecretBlockedError);
          assert.equal(err.code, 'PROMPT_SECRET_BLOCKED');
          assert.ok(err.patterns.includes(family));
          assert.ok(!err.message.includes(secret), 'error must not echo the secret value');
          return true;
        },
      );
    });
  }

  for (const sample of FALSE_POSITIVE_BOUNDARY) {
    it(`does not flag: ${sample.slice(0, 48)}`, () => {
      assert.deepEqual(scanPromptForSecrets(sample), []);
      assert.equal(assertPromptSafe(sample, { adapter: 'test' }), sample);
    });
  }
});

describe('pre-send secret scan: block semantics', () => {
  it('default mode is block', () => {
    assert.equal(getPreSendScanMode(), 'block');
  });

  it('block: audit + HIGH notify fire, adapter never invoked', async () => {
    const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const notifies: unknown[] = [];
    setPreSendScanSinks({
      audit: (action, detail) => audits.push({ action, detail }),
      notify: (event) => notifies.push(event),
    });
    const stub = new StubAdapter([{ text: 'served', toolCalls: [] }]);
    const secretPrompt = 'Deploy with key AKIAIOSFODNN7EXAMPLE today';
    await assert.rejects(
      () => stub.invoke({ prompt: secretPrompt, tools: [] }),
      (err: unknown) => err instanceof PreSendSecretBlockedError,
    );
    assert.equal(stub.remaining, 1, 'blocked invoke must not consume a scripted response');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'PROMPT_SECRET_BLOCKED');
    assert.deepEqual(audits[0].detail.patterns, ['aws-access-key']);
    assert.equal(notifies.length, 1);
    assert.equal((notifies[0] as { type: string }).type, 'PROMPT_SECRET_BLOCKED');
    // audit/notify must not carry the secret value either
    assert.ok(!JSON.stringify(audits[0]).includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('clean prompt passes through untouched', async () => {
    const stub = new StubAdapter([{ text: 'served', toolCalls: [] }]);
    const out = await stub.invoke({ prompt: 'Write a haiku about the sea.', tools: [] });
    assert.equal(out.text, 'served');
    assert.equal(stub.remaining, 0);
  });

  it('works with no sinks installed (fail-closed without wiring)', () => {
    setPreSendScanSinks({});
    assert.throws(
      () => assertPromptSafe('key AKIAIOSFODNN7EXAMPLE', { adapter: 'test' }),
      PreSendSecretBlockedError,
    );
  });
});

describe('pre-send secret scan: redact mode', () => {
  it('redacts matches and releases the sanitized prompt', () => {
    setPreSendScanMode('redact');
    const audits: Array<{ action: string }> = [];
    const notifies: unknown[] = [];
    setPreSendScanSinks({
      audit: (action) => audits.push({ action }),
      notify: (event) => notifies.push(event),
    });
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const out = assertPromptSafe(`Deploy with key ${secret} today`, { adapter: 'test' });
    assert.ok(!out.includes(secret), 'redacted prompt must not contain the secret');
    assert.ok(out.includes('[REDACTED]'));
    assert.deepEqual(audits.map((a) => a.action), ['PROMPT_SECRET_REDACTED']);
    assert.equal(notifies.length, 0, 'redact mode is lenient: no HIGH alert');
  });

  it('finds a real secret even when a placeholder match comes first', () => {
    const prompt = 'First set api_key = YOUR_KEY_HERE, then use api_key = "realsecretvalue1"';
    const found = scanPromptForSecrets(prompt);
    assert.ok(found.includes('generic-api-key'), 'placeholder-first ordering must not mask the real secret');
  });

  it('redact keeps placeholder-looking values but removes real secrets', () => {
    setPreSendScanMode('redact');
    const clean = assertPromptSafe('Set api_key = YOUR_KEY_HERE first', { adapter: 'test' });
    assert.equal(clean, 'Set api_key = YOUR_KEY_HERE first', 'placeholder-only prompt passes through');
    const mixed = assertPromptSafe('A: api_key = YOUR_KEY_HERE; B: api_key = "realsecretvalue1"', {
      adapter: 'test',
    });
    assert.ok(mixed.includes('YOUR_KEY_HERE'), 'placeholder kept');
    assert.ok(!mixed.includes('realsecretvalue1'), 'real secret redacted');
    assert.ok(mixed.includes('[REDACTED]'));
  });
});
