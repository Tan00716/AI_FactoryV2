/**
 * HMAC signature verification + replay protection (R7-#5).
 *
 * Verification order matters (DoS shape):
 *   1. timestamp parse + window check (cheap, no secret needed)
 *   2. HMAC check (constant-time compare)
 *   3. nonce replay check — ONLY after a valid signature, so an
 *      unauthenticated caller cannot burn nonces to block real senders
 * The nonce ring is process-local: a server restart clears it, which
 * is safe (a replayed event after restart still hits the event-id
 * dedup ring only if the restart was recent — documented in README;
 * the signature + window alone already bound replay to 5 minutes).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MAX_NONCES,
  SIGNATURE_PREFIX,
  TIMESTAMP_WINDOW_SECONDS,
} from './types';

export type VerifyFailureReason =
  | 'missing-signature'
  | 'missing-timestamp'
  | 'missing-nonce'
  | 'bad-timestamp'
  | 'stale-timestamp'
  | 'bad-signature'
  | 'replay-nonce'
  | 'missing-secret';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

/** Canonical signed string. The separators are fixed so a sender and the
 * receiver cannot disagree about what was signed. */
export function signedPayload(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

/** `sha256=<hex>` for a payload under a secret. Exported so senders and
 * tests share the exact scheme (and so the smoke script can sign). */
export function signPayload(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  const hex = createHmac('sha256', secret).update(signedPayload(timestamp, nonce, rawBody), 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/** Constant-time comparison that never throws on length mismatch. */
function signaturesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify one delivery. `nowSeconds` is injected for deterministic tests.
 * Does NOT consume the nonce — call `NonceRing.remember` only after
 * this returns ok (see the module docstring for why).
 */
export function verifySignature(
  secret: string | null,
  signature: string | null,
  timestamp: string | null,
  nonce: string | null,
  rawBody: string,
  nowSeconds: number,
): VerifyResult {
  if (!secret) return { ok: false, reason: 'missing-secret' };
  if (!signature) return { ok: false, reason: 'missing-signature' };
  if (!timestamp) return { ok: false, reason: 'missing-timestamp' };
  if (!nonce) return { ok: false, reason: 'missing-nonce' };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale-timestamp' };
  }
  const expected = signPayload(secret, timestamp, nonce, rawBody);
  if (!signaturesEqual(signature, expected)) return { ok: false, reason: 'bad-signature' };
  return { ok: true };
}

/** In-memory nonce store with TTL eviction and a hard cap. */
export class NonceRing {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowSeconds: number = TIMESTAMP_WINDOW_SECONDS) {
    this.windowMs = windowSeconds * 1000;
  }

  /** True when the nonce was already consumed inside the window. */
  has(nonce: string, nowMs: number): boolean {
    this.prune(nowMs);
    const expiry = this.seen.get(nonce);
    return expiry !== undefined && expiry > nowMs;
  }

  /** Consume a nonce (call only after signature verification passed). */
  remember(nonce: string, nowMs: number): void {
    this.prune(nowMs);
    this.seen.set(nonce, nowMs + this.windowMs);
    while (this.seen.size > MAX_NONCES) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  private prune(nowMs: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= nowMs) this.seen.delete(nonce);
    }
  }
}
