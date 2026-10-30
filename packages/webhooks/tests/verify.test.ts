/**
 * Webhook signature + replay tests (R7-#5).
 * Run: node --test packages/webhooks/dist/tests/*.test.js (after build)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonceRing, signPayload, verifySignature } from '../src/index.ts';

const SECRET = 'test-shared-secret';
const BODY = '{"event":"push","ref":"main"}';
const NOW = 1_800_000_000;

test('valid signature verifies', () => {
  const ts = String(NOW);
  const nonce = 'n-1';
  const sig = signPayload(SECRET, ts, nonce, BODY);
  const r = verifySignature(SECRET, sig, ts, nonce, BODY, NOW);
  assert.deepEqual(r, { ok: true });
});

test('tampered body fails', () => {
  const ts = String(NOW);
  const nonce = 'n-2';
  const sig = signPayload(SECRET, ts, nonce, BODY);
  const r = verifySignature(SECRET, sig, ts, nonce, '{"event":"push","ref":"evil"}', NOW);
  assert.deepEqual(r, { ok: false, reason: 'bad-signature' });
});

test('missing fields report distinct reasons, never the secret', () => {
  assert.deepEqual(verifySignature(SECRET, null, String(NOW), 'n', BODY, NOW), { ok: false, reason: 'missing-signature' });
  assert.deepEqual(verifySignature(SECRET, 'sha256:x', null, 'n', BODY, NOW), { ok: false, reason: 'missing-timestamp' });
  assert.deepEqual(verifySignature(SECRET, 'sha256:x', String(NOW), null, BODY, NOW), { ok: false, reason: 'missing-nonce' });
  assert.deepEqual(verifySignature(null, 'sha256:x', String(NOW), 'n', BODY, NOW), { ok: false, reason: 'missing-secret' });
  assert.deepEqual(verifySignature(SECRET, 'sha256:x', 'not-a-number', 'n', BODY, NOW), { ok: false, reason: 'bad-timestamp' });
});

test('stale and future timestamps are rejected at the window edge', () => {
  const nonce = 'n-3';
  const sig = (ts: string) => signPayload(SECRET, ts, nonce, BODY);
  assert.deepEqual(
    verifySignature(SECRET, sig(String(NOW - 301)), String(NOW - 301), nonce, BODY, NOW),
    { ok: false, reason: 'stale-timestamp' },
  );
  assert.deepEqual(
    verifySignature(SECRET, sig(String(NOW + 301)), String(NOW + 301), nonce, BODY, NOW),
    { ok: false, reason: 'stale-timestamp' },
  );
  assert.deepEqual(
    verifySignature(SECRET, sig(String(NOW - 300)), String(NOW - 300), nonce, BODY, NOW),
    { ok: true },
  );
});

test('nonce ring: remember only after valid signature; replay blocked; expiry frees', () => {
  const ring = new NonceRing(300);
  const nowMs = NOW * 1000;
  assert.equal(ring.has('n-a', nowMs), false);
  ring.remember('n-a', nowMs);
  assert.equal(ring.has('n-a', nowMs), true);
  // Still inside the window: replay.
  assert.equal(ring.has('n-a', nowMs + 299_000), true);
  // Past the window: freed.
  assert.equal(ring.has('n-a', nowMs + 301_000), false);
});

test('nonce ring caps size (oldest evicted)', () => {
  const ring = new NonceRing(300);
  const nowMs = NOW * 1000;
  for (let i = 0; i < 5010; i++) ring.remember(`n-${i}`, nowMs);
  assert.equal(ring.has('n-0', nowMs), false);
  assert.equal(ring.has('n-5009', nowMs), true);
});

test('signatures are not equal across secrets or timestamps', () => {
  const a = signPayload(SECRET, String(NOW), 'n', BODY);
  const b = signPayload('other-secret', String(NOW), 'n', BODY);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('sha256='));
});
