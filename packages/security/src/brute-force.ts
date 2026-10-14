/**
 * @ai-factory/security — brute-force detector (Batch 42, §81 'security-issue').
 *
 * What this is: a DETERMINISTIC counter, not a classifier. A source key
 * (client remote address) that accumulates `threshold` HTTP 401 denials
 * inside a sliding `windowMs` window is, by counting fact, hammering the
 * auth gate — no regex, no heuristics, no ML. That is the §81
 * 'security-issue' emission point the Batch 41 survey asked for
 * ("401 聚合→暴力破解告警").
 *
 * What this is NOT:
 *  - Not a blocker. It never denies, allows, or delays a request. The
 *    401 gate (apps/server/src/auth.ts) is upstream and independent.
 *  - Not persisted. Counters live in process memory. Rationale, written
 *    down honestly:
 *      1. The counter is a sliding-window rate signal; a restart
 *         naturally resets the window. An attacker who keeps hammering
 *         after a restart refills the new window and re-triggers —
 *         the durable artifact is the emitted needsHuman row, which
 *         DOES persist (insert-only, terminal).
 *      2. Persisting a counter write per 401 would let the attacker
 *         dictate the detector's write volume — a disk-fill DoS
 *         against the detector itself. (The AUTH_DENIED audit row
 *         already persists per denial; a second per-event write
 *         doubles it.)
 *  - Not a secret store. Grouping uses sha256(first 4 chars of the
 *    presented bearer), truncated — deterministic grouping with no
 *    token material retained. See tokenPrefixHash().
 *
 * Single 401s never cross the threshold (Batch 41: a single 401 may be
 * a mistyped token — emitting on it would be noise). A successful
 * authenticated login clears the source's counter: the next window
 * starts clean.
 *
 * Fail-closed / degradation semantics (Batch 42 task requirement):
 *  - The detector is advisory-only. If it throws, the caller must
 *    catch, audit, and continue: the 401 already stands (the gate ran
 *    first), so a detector bug can never "let an attack through", and
 *    a failed detector emits nothing (no false positive from an
 *    error path) — the miss is audited, not silent.
 *
 * Zero external dependencies; node:crypto only. Clock is injectable
 * for deterministic tests.
 */
import { createHash } from 'node:crypto';

/** Default sliding window: 5 minutes. */
export const BRUTE_FORCE_WINDOW_MS = 5 * 60 * 1000;
/** Default threshold: 10 denials inside the window. */
export const BRUTE_FORCE_THRESHOLD = 10;

export interface BruteForceDetectorOptions {
  /** Denials inside the window that trip the signal. Default 10. */
  threshold?: number;
  /** Sliding window in ms. Default 5 minutes. */
  windowMs?: number;
  /** Clock, ms since epoch. Default Date.now. Inject for tests. */
  now?: () => number;
}

export interface DenialOutcome {
  /** Denials from this key inside the current window (after pruning). */
  count: number;
  /** True when count >= threshold. The caller dedups emission against
   *  the needsHuman store (one OPEN per source); the detector itself
   *  stays stateless counting. */
  crossed: boolean;
  /** Distinct presented-token prefix hashes seen inside the window —
   *  forensic detail for the emission, not part of the threshold. */
  distinctPrefixes: number;
  /** Oldest denial still inside the window (ms epoch), or null. */
  firstAt: number | null;
  /** Newest denial inside the window (ms epoch), or null. */
  lastAt: number | null;
}

interface DenialHit {
  at: number;
  prefixHash: string;
}

/**
 * Sliding-window per-source 401 counter. Pure counting — no I/O,
 * no persistence, no blocking.
 */
export class BruteForceDetector {
  readonly threshold: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, DenialHit[]>();

  constructor(opts: BruteForceDetectorOptions = {}) {
    this.threshold = opts.threshold ?? BRUTE_FORCE_THRESHOLD;
    this.windowMs = opts.windowMs ?? BRUTE_FORCE_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    if (!Number.isFinite(this.threshold) || this.threshold < 1) {
      throw new Error(`BruteForceDetector: threshold must be >= 1, got ${this.threshold}`);
    }
    if (!Number.isFinite(this.windowMs) || this.windowMs < 1) {
      throw new Error(`BruteForceDetector: windowMs must be >= 1, got ${this.windowMs}`);
    }
  }

  /** Record one 401 denial for sourceKey. Returns the window outcome. */
  noteDenial(sourceKey: string, prefixHash = 'none'): DenialOutcome {
    const at = this.now();
    const list = this.hits.get(sourceKey) ?? [];
    list.push({ at, prefixHash });
    const pruned = prune(list, at - this.windowMs);
    if (pruned.length === 0) this.hits.delete(sourceKey);
    else this.hits.set(sourceKey, pruned);
    return outcome(pruned, this.threshold);
  }

  /**
   * A successful authenticated login from sourceKey clears its counter.
   * The next window starts clean — a legit user who fat-fingered a token
   * nine times and then logged in correctly is not one denial away
   * from a security alert forever.
   *
   * Honest nuance: the key is the source IP, so on a shared IP (NAT,
   * loopback) one client's legitimate request clears the whole IP's
   * counter. That is inherent to IP-keyed detection, not a flaw in
   * the rule — a sustained attacker still trips the threshold between
   * legitimate requests, and slowing down to dodge the window is
   * itself a 10x rate cut.
   */
  noteSuccess(sourceKey: string): void {
    this.hits.delete(sourceKey);
  }

  /** Test/introspection hook: current in-window count for a key. */
  countFor(sourceKey: string): number {
    const list = this.hits.get(sourceKey);
    if (!list) return 0;
    return prune(list, this.now() - this.windowMs).length;
  }
}

function prune(list: DenialHit[], cutoffExclusive: number): DenialHit[] {
  // Hits are appended in non-decreasing `at` order for a sane clock;
  // a linear scan keeps this correct even if the clock jumps.
  return list.filter((h) => h.at > cutoffExclusive);
}

function outcome(pruned: DenialHit[], threshold: number): DenialOutcome {
  const distinct = new Set<string>();
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const h of pruned) {
    distinct.add(h.prefixHash);
    if (firstAt === null || h.at < firstAt) firstAt = h.at;
    if (lastAt === null || h.at > lastAt) lastAt = h.at;
  }
  return {
    count: pruned.length,
    crossed: pruned.length >= threshold,
    distinctPrefixes: distinct.size,
    firstAt,
    lastAt,
  };
}

/**
 * Deterministic grouping key for the presented credential — sha256 of
 * the first 4 presented characters, hex, truncated to 16. Grouping only:
 * it cannot be reversed into the token, and the full header value is
 * never stored, logged, or returned. 'none' when no (or no parseable)
 * Authorization header was presented.
 */
export function tokenPrefixHash(authorization: unknown): string {
  if (typeof authorization !== 'string') return 'none';
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const presented = m?.[1]?.trim() ?? '';
  if (!presented) return 'none';
  return createHash('sha256').update(presented.slice(0, 4), 'utf8').digest('hex').slice(0, 16);
}
