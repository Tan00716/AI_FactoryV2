/**
 * Audit log — spec §70, hash chain per §32.
 * Append-only and immutable: high-impact actions (agent created, permission
 * granted, file changed, deployment, approval, …) are recorded here and can
 * never be updated or deleted. There is intentionally no update/delete API
 * on AuditLog or on the built-in store, and list() hands out deep copies so
 * callers cannot mutate the stored chain in memory.
 *
 * §32 hash chain: every record written through AuditLog.record carries a
 * `prevHash` (the previous chained record's `summaryHash`, or
 * AUDIT_CHAIN_GENESIS for the first) and a `summaryHash` computed at append
 * time as sha256 over the canonical record content (see auditHashInput).
 * Callers can never supply either hash. verifyAuditChain() re-derives the
 * chain and detects tampering with any chained record's content or order.
 * The SQLite store persists reason/result/summary_hash/prev_hash alongside
 * the §70 columns, so records written through it reload with their chain
 * links intact and the chain verifies across restarts. Records written
 * before chaining existed (no hash fields — e.g. rows in an older SQLite
 * database whose hash columns are NULL) are "legacy": they are skipped by
 * the chain, reported via `legacyCount`, and never by themselves mark the
 * chain broken.
 */

import { createHash, randomUUID } from 'crypto';
import { AuditRecord, nowIso } from './types';

/** prevHash of the first chained record — the chain's genesis link. */
export const AUDIT_CHAIN_GENESIS = 'GENESIS';

/** Optional §32 fields a caller may attach when recording an action. */
export interface AuditRecordOptions {
  /** Why the action was taken (justification). */
  reason?: string;
  /** Outcome of the action (e.g. 'ALLOWED', 'DENIED', 'SUCCEEDED'). */
  result?: string;
}

/**
 * Canonical JSON: object keys sorted recursively, stable across writers.
 * Mirrors the approach in packages/policy (canonicalJson) — re-implemented
 * locally so core stays dependency-free.
 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The exact content a record's summaryHash commits to: every record field
 * except summaryHash itself, with prevHash included (that is what links the
 * chain) and absent reason/result normalized to null so a record serialized
 * without the optional keys hashes identically.
 */
function auditHashInput(r: AuditRecord): Record<string, unknown> {
  return {
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    details: r.details,
    reason: r.reason ?? null,
    result: r.result ?? null,
    prevHash: r.prevHash ?? null,
  };
}

function computeSummaryHash(r: AuditRecord): string {
  return createHash('sha256').update(canonicalJson(auditHashInput(r))).digest('hex');
}

export interface AuditChainVerification {
  /**
   * True when every chained record present verified: no content tampering
   * and no broken/reordered links were detected. Note this says nothing
   * about legacy records — a result with verifiedCount 0 means "nothing
   * verifiable", not "proven intact".
   */
  ok: boolean;
  /** Index (into the input array) of the first chained record that fails. */
  brokenAt?: number;
  /** Records carrying both chain fields whose hash + link recomputed true. */
  verifiedCount: number;
  /** Records without chain fields (pre-chaining data) — unverified, not corrupt. */
  legacyCount: number;
}

/**
 * Verify a sequence of audit records against the §32 hash chain.
 *
 * Semantics: legacy records (missing summaryHash or prevHash) are counted
 * and skipped — they neither advance nor break the chain, wherever they sit.
 * For each chained record, in array order: its prevHash must equal the
 * previous chained record's summaryHash (AUDIT_CHAIN_GENESIS for the first),
 * and its summaryHash must recompute exactly from its content. The first
 * record failing either check is reported as `brokenAt` and verification
 * stops there (everything after a break is untrustworthy anyway).
 */
export function verifyAuditChain(records: readonly AuditRecord[]): AuditChainVerification {
  let prev = AUDIT_CHAIN_GENESIS;
  let verifiedCount = 0;
  let legacyCount = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (typeof r.summaryHash !== 'string' || typeof r.prevHash !== 'string') {
      legacyCount++;
      continue;
    }
    if (r.prevHash !== prev || computeSummaryHash(r) !== r.summaryHash) {
      return { ok: false, brokenAt: i, verifiedCount, legacyCount };
    }
    prev = r.summaryHash;
    verifiedCount++;
  }
  return { ok: true, verifiedCount, legacyCount };
}

export interface AuditStore {
  append(r: AuditRecord): void;
  list(): AuditRecord[];
  /**
   * Count records by actor and action set (Batch 41: §81 'policy-violation'
   * emission counts repeated ceiling denials per actor). The SQLite
   * implementation answers with an indexed COUNT query instead of
   * hydrating the whole chain — denials are rare but the chain is
   * unbounded, so a full list() scan per denial would not scale.
   */
  countByActorAction(actor: string, actions: readonly string[]): number;
}

export class InMemoryAuditStore implements AuditStore {
  private records: AuditRecord[] = [];
  append(r: AuditRecord): void {
    this.records.push(structuredClone(r));
  }
  list(): AuditRecord[] {
    return this.records.map((r) => structuredClone(r));
  }
  countByActorAction(actor: string, actions: readonly string[]): number {
    const set = new Set(actions);
    let n = 0;
    for (const r of this.records) {
      if (r.actor === actor && set.has(r.action)) n++;
    }
    return n;
  }
}

export class AuditLog {
  constructor(private store: AuditStore = new InMemoryAuditStore()) {}

  /**
   * The summaryHash the next record must link to: the last chained record
   * currently in the store, or the genesis constant when the store holds no
   * chained record yet. Read from the store on every record() so several
   * AuditLog instances over one store still extend a single chain.
   */
  private chainHead(): string {
    const all = this.store.list();
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i].summaryHash;
      if (typeof h === 'string') return h;
    }
    return AUDIT_CHAIN_GENESIS;
  }

  /** Record a high-impact action. There is intentionally no update/delete API. */
  record(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown> = {},
    opts: AuditRecordOptions = {},
  ): AuditRecord {
    const r: AuditRecord = {
      id: randomUUID(),
      ts: nowIso(),
      actor,
      action,
      entityType,
      entityId,
      details: structuredClone(details),
      prevHash: this.chainHead(),
    };
    if (opts.reason !== undefined) r.reason = opts.reason;
    if (opts.result !== undefined) r.result = opts.result;
    r.summaryHash = computeSummaryHash(r);
    this.store.append(r);
    // Return a copy: the caller must not be able to rewrite the stored
    // record (and silently break the chain) through the returned reference.
    return structuredClone(r);
  }

  list(): AuditRecord[] {
    return this.store.list();
  }

  /**
   * Count records by actor and action set. Delegates to the store so the
   * SQLite implementation can answer with a COUNT query (Batch 41).
   */
  countByActorAction(actor: string, actions: readonly string[]): number {
    return this.store.countByActorAction(actor, actions);
  }

  /** Verify the stored records against the §32 hash chain. */
  verify(): AuditChainVerification {
    return verifyAuditChain(this.store.list());
  }
}
