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
 * Replace every exact occurrence of each resolved value with `***`.
 * Used at consumption points whose output is logged or returned
 * (§46.2: stdout/stderr 统一脱敏). Empty values are skipped; matching
 * is exact-substring, longest first so overlapping values redact
 * cleanly.
 */
export function redactSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  for (const v of sorted) {
    out = out.split(v).join('***');
  }
  return out;
}
