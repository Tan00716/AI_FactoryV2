/**
 * The Secret Broker (§46.2).
 *
 * Consumers hold refs; the broker resolves them against an ordered
 * chain of backends (first hit wins) and hands the plaintext directly
 * to the consumption point. Values are never written into audit
 * events, error messages or metadata — the audit hook receives
 * identifiers and outcomes only.
 *
 * Short-term leases (§46.2 "短期租约"): `lease()` returns a handle
 * whose value self-destructs at expiry, and §46.2's "rotation /
 * revocation 使旧 Capability 失效" is implemented literally — set()
 * (rotation) and delete() revoke every outstanding lease for that
 * name, on every backend.
 */
import {
  SecretBackendUnavailableError,
  SecretLeaseExpiredError,
  SecretNotFoundError,
  SecretReadOnlyError,
  assertSecretName,
  parseSecretRef,
  type Clock,
  type SecretAccessOptions,
  type SecretAuditEvent,
  type SecretMetadata,
  type SecretStore,
} from './types';

export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface SecretBrokerOptions {
  /** Resolution order: earlier stores win. */
  stores: SecretStore[];
  audit?: (event: SecretAuditEvent) => void;
  clock?: Clock;
  leaseTtlMs?: number;
}

export class SecretLease {
  readonly name: string;
  readonly ref: string;
  readonly backend: string;
  readonly expiresAt: number;
  private value_: string | null;
  private revoked_ = false;

  constructor(
    init: { name: string; backend: string; value: string; expiresAt: number },
    private readonly clock: Clock,
    private readonly onClose: (lease: SecretLease) => void,
  ) {
    this.name = init.name;
    this.ref = `secret://${init.name}`;
    this.backend = init.backend;
    this.expiresAt = init.expiresAt;
    this.value_ = init.value;
  }

  get active(): boolean {
    return !this.revoked_ && this.value_ !== null && this.clock.now() < this.expiresAt;
  }

  /** The plaintext, transiently. Throws once the lease has expired
   *  or been revoked (rotation / deletion revoke outstanding leases). */
  get value(): string {
    if (!this.active || this.value_ === null) {
      throw new SecretLeaseExpiredError(
        `lease for secret://${this.name} is no longer active (expired or revoked)`,
      );
    }
    return this.value_;
  }

  revoke(): void {
    if (this.revoked_) return;
    this.revoked_ = true;
    this.value_ = null;
    this.onClose(this);
  }
}

export class SecretBroker {
  private readonly stores: SecretStore[];
  private readonly auditHook?: (event: SecretAuditEvent) => void;
  private readonly clock: Clock;
  private readonly leaseTtlMs: number;
  private readonly leases = new Map<string, Set<SecretLease>>();

  constructor(opts: SecretBrokerOptions) {
    if (opts.stores.length === 0) {
      throw new SecretBackendUnavailableError('secret broker configured with no backends');
    }
    this.stores = opts.stores;
    this.auditHook = opts.audit;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Backends in resolution order (ids only — safe to display). */
  get backends(): string[] {
    return this.stores.map((s) => s.id);
  }

  private audit(event: Omit<SecretAuditEvent, 'at' | 'ref'> & { name: string }): void {
    if (!this.auditHook) return;
    try {
      this.auditHook({
        ...event,
        ref: `secret://${event.name}`,
        at: new Date(this.clock.now()).toISOString(),
      });
    } catch {
      /* an audit sink must never break secret handling itself */
    }
  }

  /** First store (in order) holding the name, with its value. Backend
   *  errors propagate (a failure is not a miss). */
  private async find(
    name: string,
  ): Promise<{ store: SecretStore; value: string } | undefined> {
    for (const store of this.stores) {
      const value = await store.get(name);
      if (value !== undefined) return { store, value };
    }
    return undefined;
  }

  /** find + audit shared by resolve() and lease(). */
  private async resolveHit(
    name: string,
    opts: SecretAccessOptions,
  ): Promise<{ store: SecretStore; value: string }> {
    let hit: { store: SecretStore; value: string } | undefined;
    try {
      hit = await this.find(name);
    } catch (e) {
      this.audit({
        action: 'SECRET_BACKEND_ERROR',
        actor: opts.actor,
        name,
        backend: null,
        purpose: opts.purpose ?? null,
        error: (e as Error).name,
      });
      throw e;
    }
    if (!hit) {
      this.audit({
        action: 'SECRET_NOT_FOUND',
        actor: opts.actor,
        name,
        backend: null,
        purpose: opts.purpose ?? null,
      });
      throw new SecretNotFoundError(name);
    }
    this.audit({
      action: 'SECRET_RESOLVED',
      actor: opts.actor,
      name,
      backend: hit.store.id,
      purpose: opts.purpose ?? null,
    });
    return hit;
  }

  /**
   * Resolve a ref to its plaintext for immediate consumption. The
   * caller must use the value transiently (inject it, then drop it).
   * A miss throws the uniform SecretNotFoundError.
   */
  async resolve(refOrName: string, opts: SecretAccessOptions): Promise<string> {
    const name = parseSecretRef(refOrName);
    return (await this.resolveHit(name, opts)).value;
  }

  /** Resolve under a short-term lease (§46.2). */
  async lease(refOrName: string, opts: SecretAccessOptions): Promise<SecretLease> {
    const name = parseSecretRef(refOrName);
    const hit = await this.resolveHit(name, opts);
    const lease = new SecretLease(
      {
        name,
        backend: hit.store.id,
        value: hit.value,
        expiresAt: this.clock.now() + this.leaseTtlMs,
      },
      this.clock,
      (l) => this.unregisterLease(l),
    );
    let set = this.leases.get(name);
    if (!set) {
      set = new Set();
      this.leases.set(name, set);
    }
    set.add(lease);
    this.audit({
      action: 'SECRET_LEASED',
      actor: opts.actor,
      name,
      backend: lease.backend,
      purpose: opts.purpose ?? null,
    });
    return lease;
  }

  private unregisterLease(lease: SecretLease): void {
    this.leases.get(lease.name)?.delete(lease);
  }

  private revokeLeases(name: string, actor: string): void {
    const set = this.leases.get(name);
    if (!set || set.size === 0) return;
    for (const lease of [...set]) {
      lease.revoke();
      this.audit({
        action: 'SECRET_LEASE_REVOKED',
        actor,
        name,
        backend: lease.backend,
        purpose: null,
      });
    }
    this.leases.delete(name);
  }

  /**
   * Create or rotate a secret. Written to the FIRST writable backend
   * in the chain (resolution order puts it first, so it shadows any
   * same-named entry behind it). Rotating revokes outstanding leases.
   */
  async set(
    name: string,
    value: string,
    opts: SecretAccessOptions & { purpose?: string },
  ): Promise<SecretMetadata> {
    assertSecretName(name);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('secret value must be a non-empty string');
    }
    const target = this.stores.find((s) => s.writable && typeof s.set === 'function');
    if (!target) {
      throw new SecretReadOnlyError(
        `no writable secret backend is configured (backends: ${this.backends.join(', ')}); ` +
          `the value was not stored anywhere`,
      );
    }
    const existed = (await this.find(name)) !== undefined;
    await target.set!(name, value, { purpose: opts.purpose });
    this.revokeLeases(name, opts.actor);
    this.audit({
      action: 'SECRET_SET',
      actor: opts.actor,
      name,
      backend: target.id,
      purpose: opts.purpose ?? null,
      rotated: existed,
    });
    return this.describe(name);
  }

  /** Delete from every backend that holds the name; revokes leases. */
  async delete(name: string, opts: SecretAccessOptions): Promise<boolean> {
    assertSecretName(name);
    let deleted = false;
    for (const store of this.stores) {
      if (typeof store.delete !== 'function') continue;
      if (await store.delete(name)) deleted = true;
    }
    if (deleted) {
      this.revokeLeases(name, opts.actor);
      this.audit({
        action: 'SECRET_DELETED',
        actor: opts.actor,
        name,
        backend: null,
        purpose: opts.purpose ?? null,
      });
    }
    return deleted;
  }

  /** Metadata for one ref — never throws on a miss (exists:false). */
  async describe(refOrName: string): Promise<SecretMetadata> {
    const name = parseSecretRef(refOrName);
    for (const store of this.stores) {
      // Presence is probed via list() where possible and get() only as
      // a presence check — the value itself is discarded here.
      const present =
        (await store.list()).includes(name) || (await store.get(name)) !== undefined;
      if (present) {
        return {
          name,
          ref: `secret://${name}`,
          backend: store.id,
          exists: true,
          purpose: (await store.purposeOf?.(name)) ?? null,
          updatedAt: (await store.updatedAtOf?.(name)) ?? null,
        };
      }
    }
    return { name, ref: `secret://${name}`, backend: null, exists: false, purpose: null, updatedAt: null };
  }

  /** Union of metadata across backends; first holder wins per name. */
  async list(): Promise<SecretMetadata[]> {
    const seen = new Map<string, SecretMetadata>();
    for (const store of this.stores) {
      for (const name of await store.list()) {
        if (seen.has(name)) continue;
        seen.set(name, {
          name,
          ref: `secret://${name}`,
          backend: store.id,
          exists: true,
          purpose: (await store.purposeOf?.(name)) ?? null,
          updatedAt: (await store.updatedAtOf?.(name)) ?? null,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Result of counted redaction: the redacted text plus the deterministic
 * number of exact-substring replacements actually performed.
 */
export interface RedactionResult {
  text: string;
  /**
   * Exact count of `***` substitutions performed. This is a
   * deterministic count of what happened (N replacements), not a
   * heuristic judgment about the content — every hit is an exact
   * occurrence of a known injected value.
   */
  hits: number;
}

/**
 * Like redactSecretValues, but also returns how many replacements were
 * performed. Counting is sequential over values (longest first), so
 * `hits` is exactly the number of `***` substitutions in `text`.
 */
export function redactSecretValuesCounted(
  text: string,
  values: readonly string[],
): RedactionResult {
  let out = text;
  let hits = 0;
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    const parts = out.split(v);
    if (parts.length > 1) {
      hits += parts.length - 1;
      out = parts.join('***');
    }
  }
  return { text: out, hits };
}

/**
 * Replace every exact occurrence of each resolved value with `***`.
 * Used at consumption points whose output is logged or returned
 * (§46.2: stdout/stderr 统一脱敏). Empty values are skipped; matching
 * is exact-substring, longest first so overlapping values redact
 * cleanly.
 *
 * Kept byte-for-byte behavior-compatible: implemented on top of
 * redactSecretValuesCounted; callers that need the hit count use the
 * counted variant directly.
 */
export function redactSecretValues(text: string, values: readonly string[]): string {
  return redactSecretValuesCounted(text, values).text;
}


/**
 * Stateful cross-chunk secret redactor (Batch 48 — terminal §50.1).
 *
 * The per-chunk `redactSecretValuesCounted` misses a secret value split
 * across two output chunks (neither chunk alone contains a full match).
 * This redactor closes that hole: it feeds every push through the same
 * longest-first exact-substring matcher, but only COMMITS a match once
 * it is provably complete — a match ending at code-point index `e` in
 * the combined (pending + chunk) text is committed only if
 * `e <= len - carryLen`, where `carryLen = longestValueLength - 1`.
 *
 * Why that threshold is airtight: a committed match could only be
 * "wrong" if a longer injected value started at (or overlapping) the
 * match and extended beyond the combined text. Any such longer value
 * has length <= carryLen + 1, so from the match's start it reaches at
 * most `e + carryLen <= len` — i.e. it would fit entirely inside the
 * combined text, where longest-first matching would already have
 * preferred it. Hence nothing committed can be retroactively
 * invalidated by future chunks — not even when a shorter value is a
 * strict prefix of a longer one (e.g. "AB" vs "ABCDEF" split as
 * "…AB" | "CDEF…": the "AB" match is correctly deferred, then the
 * "ABCDEF" match wins on the longer combined text).
 *
 * Uncommitted bytes stay RAW in the pending tail and are re-examined
 * on the next push; `flush()` commits everything at stream end. The
 * concatenated emits + flush equal whole-stream
 * `redactSecretValuesCounted` output — nothing duplicated, nothing
 * lost, hits counted exactly once per value occurrence.
 *
 * Other properties:
 *  - Carry is cut on code-point boundaries (spread), never splitting a
 *    surrogate pair, so astral-plane secrets match correctly.
 *  - Tradeoff: the last <= carryLen code points lag one chunk behind
 *    (or until flush). Pending memory is bounded by
 *    carryLen + longestValueLength, never by stream length.
 *  - Empty `values` (or all length <= 1, which can never span a chunk
 *    boundary) degrade to a transparent passthrough.
 */
export interface CrossChunkRedactor {
  /** Feed one raw output chunk; returns redacted text safe to emit now. */
  push(chunk: string): RedactionResult;
  /** Commit and emit the held tail; call once at stream end. */
  flush(): RedactionResult;
}

/** A secret-value occurrence as code-point indices into the text. */
interface SecretOccurrence {
  start: number;
  end: number;
}

/**
 * Longest-first, non-overlapping, left-to-right occurrence scan —
 * position-tracking equivalent of the sequential split/join in
 * `redactSecretValuesCounted` (so whole-stream results agree
 * byte-for-byte). `values` must already be longest-first sorted.
 */
function findSecretOccurrences(cps: string[], values: readonly string[]): SecretOccurrence[] {
  const claimed = new Array<boolean>(cps.length).fill(false);
  const out: SecretOccurrence[] = [];
  for (const v of values) {
    const vcps = [...v];
    if (vcps.length === 0 || vcps.length > cps.length) continue;
    let i = 0;
    while (i <= cps.length - vcps.length) {
      let ok = true;
      for (let k = 0; k < vcps.length; k++) {
        if (claimed[i + k] || cps[i + k] !== vcps[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push({ start: i, end: i + vcps.length });
        for (let k = 0; k < vcps.length; k++) claimed[i + k] = true;
        i += vcps.length; // non-overlapping, like split()
      } else {
        i++;
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Splice `***` over non-overlapping, start-sorted occurrences. */
function spliceRedactions(cps: string[], occurrences: SecretOccurrence[]): string {
  let out = '';
  let pos = 0;
  for (const m of occurrences) {
    out += cps.slice(pos, m.start).join('');
    out += '***';
    pos = m.end;
  }
  out += cps.slice(pos).join('');
  return out;
}

export function createCrossChunkRedactor(values: readonly string[]): CrossChunkRedactor {
  const sorted = [...values]
    .filter((v) => v.length > 0)
    .sort((a, b) => [...b].length - [...a].length);
  const longest = sorted.reduce((m, v) => Math.max(m, [...v].length), 0);
  // A value of length L can start at most L-1 code points before a
  // chunk boundary and still cross it; values of length <= 1 can never
  // span a boundary, so they need no carry.
  const carryLen = Math.max(0, longest - 1);
  let pending: string[] = []; // raw code points held for the next push

  const run = (chunk: string, commitAll: boolean): RedactionResult => {
    const cps = [...pending, ...chunk];
    const occurrences = findSecretOccurrences(cps, sorted);
    const threshold = commitAll ? cps.length : cps.length - carryLen;
    const committed = occurrences.filter((m) => m.end <= threshold);
    // Emit up to the earliest uncommitted occurrence (and never past
    // the carry holdback); everything from there stays raw pending.
    // Clamp at 0: when the combined text is shorter than the carry,
    // everything is held.
    let emitEnd = commitAll ? cps.length : Math.max(0, cps.length - carryLen);
    for (const m of occurrences) {
      if (m.end > threshold && m.start < emitEnd) emitEnd = m.start;
    }
    const emit = spliceRedactions(cps.slice(0, emitEnd), committed);
    pending = cps.slice(emitEnd);
    return { text: emit, hits: committed.length };
  };

  return {
    push: (chunk: string) => run(chunk, false),
    flush: () => run('', true),
  };
}
