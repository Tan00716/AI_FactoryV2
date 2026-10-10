/**
 * Quota buckets — SPEC v2 §27.1.
 *
 * Quota is tracked per Provider Account / Workspace / Limit Bucket; many
 * agents share one bucket — the allowance is NOT multiplied by agent count.
 * Anything the provider does not report is shown as unknown: the UI must
 * never fabricate a "73% allowance" percentage.
 */

/** How fresh the provider data is. */
export type QuotaFreshness = 'fresh' | 'stale' | 'unknown';

export type QuotaAuthState = 'ok' | 'expiring' | 'expired' | 'unknown';

/** A single limit bucket shared by every agent on the account/workspace. */
export interface QuotaBucket {
  providerAccountId: string;
  workspaceId: string;
  limitBucket: string; // e.g. "gpt-5:reasoning" / "codex:standard"
  /** Consumed units, when the provider reports them. */
  used?: number;
  /** Total units in the window, when the provider reports them. */
  limit?: number;
  windowStart?: string;
  windowEnd?: string;
  /** When the provider says the quota resets; absent ⇒ unknown. */
  resetAt?: string;
  plan?: string;
  authState: QuotaAuthState;
  collectedAt: string;
  freshness: QuotaFreshness;
}

/** Display-safe usage line. Unknown stays unknown — never fabricated. */
export function describeUsage(b: QuotaBucket): string {
  if (b.freshness === 'unknown') return 'usage unknown (provider did not report)';
  if (b.used === undefined || b.limit === undefined) {
    return `usage unknown (provider reported no numbers; freshness=${b.freshness})`;
  }
  const pct = Math.round((100 * b.used) / b.limit);
  return `${b.used}/${b.limit} used (${pct}% used, ${100 - pct}% remaining; window ${b.windowStart ?? '?'}→${b.windowEnd ?? '?'})`;
}

/** Limit events are classified separately (§27.1) — each needs its own handling. */
export type LimitEventKind =
  | 'RATE_LIMITED_429'
  | 'CREDITS_EXHAUSTED'
  | 'CONCURRENCY_LIMIT'
  | 'AUTH_EXPIRY'
  | 'PROVIDER_OUTAGE';

export interface LimitEvent {
  kind: LimitEventKind;
  bucket: QuotaBucket;
  /** Retry-After seconds, when the provider sent one (short 429s). */
  retryAfterSec?: number;
  observedAt: string;
}

export class QuotaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnknownQuotaData extends QuotaError {
  constructor(what: string) {
    super('UNKNOWN_QUOTA_DATA', `Provider did not report ${what}; refusing to fabricate a value`);
  }
}
