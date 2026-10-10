/**
 * In-memory memory store — SPEC v2 §43 (Structured Memory Engine).
 *
 * Rules implemented here:
 *  - WRITE GUARDS (§43.4): every write is scanned for raw secrets, banned
 *    "skip approval" conclusions, unevidenced manager claims, and
 *    authorization claims BEFORE dedup/merge or persistence. A prohibited
 *    write throws MemoryError and never lands.
 *  - SECURE RETRIEVAL (§43.3): `retrieve(query, requestor)` applies the
 *    ACL (accessScope) + data-classification filter FIRST, then
 *    scope/reuse/status/confidence filters, then confidence/recency
 *    ranking. Unauthorized entries are never returned — not merely hidden
 *    in the UI. A vector backend would rank at the final step, after the
 *    security filter.
 *  - DEDUP/MERGE: writing an entry with the same scope + scopeId + type +
 *    normalized title as an existing live entry merges into it (combined
 *    content, max confidence, unioned refs, refreshed updatedAt) instead
 *    of duplicating.
 *  - CONTRADICTIONS (§43.3): writing with `contradicts: [ids]` marks each
 *    live contradicted entry CONTRADICTED and stores the new entry as
 *    PROPOSED. `resolveContradiction` / `resolveBySourceAuthority` resolve
 *    by source authority (not newest date / highest score): the winner
 *    goes ACTIVE and supersedes the losers, which go RETIRED.
 *  - EXPIRY: on every read the store sweeps entries; an entry whose
 *    `expiresAt` has passed is auto-marked RETIRED and hidden from
 *    retrieval unless explicitly included.
 *  - CONFIDENCE DECAY: an entry past half its TTL loses 0.2 confidence
 *    (floored at 0), once per half-TTL window; `verify()` restores +0.1.
 *  - VERIFY: stamps `lastVerifiedAt`, +0.1 confidence (capped at 1);
 *    PROPOSED → VALIDATED, other live statuses → ACTIVE. CONTRADICTED
 *    entries are NOT verified away — contradictions must be resolved.
 *  - PURGE (§43.3): `purge(scopeId)` removes every entry of the scope and
 *    synchronously cleans its index/cache/backup references via the
 *    observable MemoryRefRegistry, returning a PurgeReport that proves
 *    the cleanup.
 *
 * The store is intentionally swappable: it keeps no I/O and takes an
 * injectable clock, so a SQLite-backed implementation can honor the same
 * contract.
 */
import { randomUUID } from 'node:crypto';
import {
  CLASSIFICATION_RANK,
  ConfidenceKind,
  CrossProjectReusable,
  DataClassification,
  MemoryEntry,
  MemoryQuery,
  MemoryRetrieveQuery,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  NewMemoryEntry,
  PurgeReport,
  RequestorIdentity,
} from './types';
import {
  MemoryError,
  assertMemoryNeverAuthorizes,
  checkManagerClaim,
  checkProhibitedConclusion,
  scanForSecrets,
  sourceAuthorityScore,
} from './guards';
import { MemoryRefRegistry } from './registry';

export interface MemoryStoreOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
  /**
   * Observable downstream-reference registry (§43.3 purge proof). When
   * provided, every write tracks index/cache/backup references and
   * `purge()` cleans them. When omitted, purge still removes the entries
   * and reports `registryClean: true`.
   */
  registry?: MemoryRefRegistry;
}

/** Confidence lost when an entry passes half its TTL (auto-degrade). */
export const DECAY_STEP = 0.2;
/** Confidence regained by one verification. */
export const VERIFY_BOOST = 0.1;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Dedup key component: case/whitespace-insensitive title. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupKey(scope: MemoryScope, scopeId: string, type: MemoryType, title: string): string {
  return `${scope}|${scopeId}|${type}|${normalizeTitle(title)}`;
}

function union<T>(a: T[], b: T[]): T[] {
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

/** Default ACL for a new entry (§43.1): `<scope>:<scopeId>`; system scope is public. */
export function defaultAccessScope(scope: MemoryScope, scopeId: string): string[] {
  return scope === 'system' ? ['*'] : [`${scope}:${scopeId}`];
}

function defaultReuse(classification: DataClassification): CrossProjectReusable {
  return { allowed: classification === 'public' };
}

/** Statuses that still participate in dedup merges (not yet resolved away). */
function isLiveForMerge(status: MemoryStatus): boolean {
  return status === 'ACTIVE' || status === 'VALIDATED' || status === 'PROPOSED' || status === 'STALE';
}

export class MemoryStore {
  private entries = new Map<string, MemoryEntry>();
  /** dedupKey -> entry id, for O(1) duplicate detection on write. */
  private byDedupKey = new Map<string, string>();
  private readonly nowFn: () => number;
  private readonly registry?: MemoryRefRegistry;

  constructor(options: MemoryStoreOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.registry = options.registry;
  }

  private nowMs(): number {
    return this.nowFn();
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** Number of entries currently held (including retired ones). */
  size(): number {
    return this.entries.size;
  }

  /**
   * Write an entry.
   *
   * 1. §43.4 guards run first (secrets, banned conclusions, manager
   *    claims, authorization claims) — a prohibited write throws and
   *    never lands.
   * 2. Dedup: same scope + scopeId + type + normalized title as a live
   *    entry merges instead of duplicating (see `merge`).
   * 3. Contradictions: `contradicts: [ids]` marks each live contradicted
   *    entry CONTRADICTED and stores this entry as PROPOSED (§43.3).
   * 4. Downstream references (index/cache/backup) are tracked in the
   *    registry when one is wired in.
   */
  write(input: NewMemoryEntry): MemoryEntry {
    if (!input.title || !input.title.trim()) {
      throw new MemoryError('INVALID_INPUT', 'title is required');
    }
    // §43.4 — guards before anything else.
    scanForSecrets(`${input.title}\n${input.content}`);
    checkProhibitedConclusion(input.title, input.content);
    checkManagerClaim(input.source, input.evidenceIds ?? [], input.type);
    assertMemoryNeverAuthorizes({ title: input.title, content: input.content, type: input.type });

    const key = dedupKey(input.scope, input.scopeId, input.type, input.title);
    const existingId = this.byDedupKey.get(key);
    const existing = existingId ? this.entries.get(existingId) : undefined;
    if (existing && isLiveForMerge(existing.status)) {
      const merged = this.merge(existing, input);
      this.applyContradictions(merged, input.contradicts ?? []);
      this.trackRefs(merged.id);
      return this.copy(merged);
    }
    if (existingId && !existing) this.byDedupKey.delete(key);

    const now = this.iso(this.nowMs());
    const classification: DataClassification = input.dataClassification ?? 'internal';
    const entry: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      scope: input.scope,
      scopeId: input.scopeId,
      type: input.type,
      title: input.title.trim(),
      content: input.content,
      source: input.source,
      sourceRefs: [...(input.sourceRefs ?? [])],
      confidence: round2(clamp01(input.confidence)),
      confidenceKind: input.confidenceKind ?? 'model-self-assessed',
      createdBy: input.createdBy,
      evidenceIds: [...(input.evidenceIds ?? [])],
      taskRefs: [...(input.taskRefs ?? [])],
      lastVerifiedAt: input.lastVerifiedAt ?? now,
      applicableScope: input.applicableScope ?? '',
      accessScope: [...(input.accessScope ?? defaultAccessScope(input.scope, input.scopeId))],
      dataClassification: classification,
      crossProjectReusable: input.crossProjectReusable
        ? { ...input.crossProjectReusable }
        : defaultReuse(classification),
      expiresAt: input.expiresAt ?? null,
      status: 'ACTIVE',
      supersedes: [...(input.supersedes ?? [])],
      contradicts: [...(input.contradicts ?? [])],
      indexVersion: input.indexVersion ?? 'v1',
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(entry.id, entry);
    this.byDedupKey.set(key, entry.id);
    this.applyContradictions(entry, input.contradicts ?? []);
    this.trackRefs(entry.id);
    return this.copy(entry);
  }

  private merge(existing: MemoryEntry, input: NewMemoryEntry): MemoryEntry {
    this.sweep(existing);
    const incoming = input.content.trim();
    if (incoming && !existing.content.includes(incoming)) {
      existing.content = existing.content ? `${existing.content}\n\n${incoming}` : incoming;
    }
    existing.confidence = round2(Math.max(existing.confidence, clamp01(input.confidence)));
    existing.evidenceIds = union(existing.evidenceIds, input.evidenceIds ?? []);
    existing.sourceRefs = union(existing.sourceRefs, input.sourceRefs ?? []);
    existing.taskRefs = union(existing.taskRefs, input.taskRefs ?? []);
    existing.accessScope = union(existing.accessScope, input.accessScope ?? []);
    existing.supersedes = union(existing.supersedes, input.supersedes ?? []);
    existing.contradicts = union(existing.contradicts, input.contradicts ?? []);
    // Conservative merge: reuse stays allowed only when both sides allow it;
    // classification keeps the more sensitive of the two.
    if (input.crossProjectReusable) {
      existing.crossProjectReusable = {
        allowed: existing.crossProjectReusable.allowed && input.crossProjectReusable.allowed,
        conditions:
          input.crossProjectReusable.conditions ?? existing.crossProjectReusable.conditions,
      };
    }
    if (input.dataClassification) {
      existing.dataClassification =
        CLASSIFICATION_RANK[input.dataClassification] > CLASSIFICATION_RANK[existing.dataClassification]
          ? input.dataClassification
          : existing.dataClassification;
    }
    if (input.source && input.source !== existing.source && !existing.source.includes(input.source)) {
      existing.source = existing.source ? `${existing.source} | ${input.source}` : input.source;
    }
    if (input.lastVerifiedAt && input.lastVerifiedAt > existing.lastVerifiedAt) {
      existing.lastVerifiedAt = input.lastVerifiedAt;
    }
    if (input.expiresAt && (!existing.expiresAt || input.expiresAt > existing.expiresAt)) {
      existing.expiresAt = input.expiresAt;
    }
    if (existing.status === 'RETIRED') {
      // Fresh corroborating evidence revives a retired entry; a later
      // sweep will re-retire it if its expiry has truly passed.
      existing.status = 'ACTIVE';
    }
    existing.updatedAt = this.iso(this.nowMs());
    this.sweep(existing);
    return existing;
  }

  /**
   * §43.3 contradiction marking: each contradicted entry that is still
   * live becomes CONTRADICTED (with a back-reference to the new entry);
   * the new entry becomes PROPOSED. Unknown ids are rejected.
   */
  private applyContradictions(entry: MemoryEntry, contradictIds: string[]): void {
    if (contradictIds.length === 0) return;
    const now = this.iso(this.nowMs());
    for (const cid of contradictIds) {
      const old = this.entries.get(cid);
      if (!old) {
        throw new MemoryError('ENTRY_NOT_FOUND', `contradicted entry ${cid} does not exist`);
      }
      if (isLiveForMerge(old.status)) {
        old.status = 'CONTRADICTED';
        old.updatedAt = now;
        if (!old.contradicts.includes(entry.id)) old.contradicts.push(entry.id);
      }
      if (!entry.contradicts.includes(cid)) entry.contradicts.push(cid);
    }
    entry.status = 'PROPOSED';
    entry.updatedAt = now;
  }

  /**
   * §43.3 contradiction resolution: the winner goes ACTIVE and supersedes
   * the losers; every loser goes RETIRED (kept for history, hidden from
   * retrieval). Which entry wins is the caller's decision — use
   * `resolveBySourceAuthority` for the spec's authority-based rule.
   */
  resolveContradiction(
    winnerId: string,
    loserIds: string[],
    resolver = 'human',
  ): { winner: MemoryEntry; losers: MemoryEntry[] } {
    void resolver;
    const winner = this.entries.get(winnerId);
    if (!winner) throw new MemoryError('ENTRY_NOT_FOUND', `winner entry ${winnerId} not found`);
    const now = this.iso(this.nowMs());
    const losers: MemoryEntry[] = [];
    for (const lid of loserIds) {
      if (lid === winnerId) continue;
      const loser = this.entries.get(lid);
      if (!loser) throw new MemoryError('ENTRY_NOT_FOUND', `loser entry ${lid} not found`);
      loser.status = 'RETIRED';
      loser.updatedAt = now;
      if (!loser.contradicts.includes(winnerId)) loser.contradicts.push(winnerId);
      losers.push(loser);
    }
    winner.status = 'ACTIVE';
    winner.supersedes = union(winner.supersedes, loserIds.filter((id) => id !== winnerId));
    winner.updatedAt = now;
    return { winner: this.copy(winner), losers: losers.map((l) => this.copy(l)) };
  }

  /**
   * §43.3: resolve a set of contradictory entries by source authority —
   * highest authority score wins (ties break by most recent update), not
   * newest date or highest confidence. Returns the winner id and the
   * resolution result.
   */
  resolveBySourceAuthority(
    entryIds: string[],
    resolver = 'human',
  ): { winnerId: string; winner: MemoryEntry; losers: MemoryEntry[] } {
    if (entryIds.length === 0) {
      throw new MemoryError('INVALID_INPUT', 'at least one entry id is required');
    }
    const ranked = entryIds.map((id) => {
      const e = this.entries.get(id);
      if (!e) throw new MemoryError('ENTRY_NOT_FOUND', `entry ${id} not found`);
      return { id, score: sourceAuthorityScore(e.source), updatedAt: e.updatedAt };
    });
    ranked.sort((a, b) => b.score - a.score || (b.updatedAt < a.updatedAt ? -1 : 1));
    const winnerId = ranked[0].id;
    const { winner, losers } = this.resolveContradiction(
      winnerId,
      ranked.slice(1).map((r) => r.id),
      resolver,
    );
    return { winnerId, winner, losers };
  }

  /** Fetch one entry by id (applies expiry sweep + decay first). */
  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.sweep(entry);
    return this.copy(entry);
  }

  /**
   * §43.3 secure retrieval: the ACL (accessScope) + data-classification
   * filter is applied FIRST; only entries the requestor is authorized for
   * proceed to scope/reuse/status/confidence filtering and to
   * confidence/recency ranking. Unauthorized entries are never returned
   * (not merely hidden in the UI).
   *
   * Cross-project visibility: when `scopeId` is set, entries from other
   * scopeIds are included only when `crossProjectReusable.allowed` is
   * true (still subject to ACL + classification). RETIRED and
   * CONTRADICTED entries are hidden unless explicitly included.
   */
  retrieve(query: MemoryRetrieveQuery, requestor: RequestorIdentity): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      this.sweep(entry);
      // 1. Security filter first: ACL, then classification.
      if (!this.aclAllows(entry, requestor)) continue;
      if (CLASSIFICATION_RANK[entry.dataClassification] > CLASSIFICATION_RANK[requestor.clearance]) {
        continue;
      }
      // 2. Scope + cross-project reuse.
      if (entry.scope !== query.scope) continue;
      if (
        query.scopeId !== undefined &&
        entry.scopeId !== query.scopeId &&
        !entry.crossProjectReusable.allowed
      ) {
        continue;
      }
      // 3. Status + confidence + type.
      if (entry.status === 'RETIRED' && !query.includeRetired) continue;
      if (entry.status === 'CONTRADICTED' && !query.includeContradicted) continue;
      if (query.type !== undefined && entry.type !== query.type) continue;
      if (query.minConfidence !== undefined && entry.confidence < query.minConfidence) continue;
      out.push(this.copy(entry));
    }
    // 4. Rank: confidence desc, then recency desc. (A vector backend would
    //    rank semantically here — after the security filter, never before.)
    out.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt < a.updatedAt ? -1 : 1;
      return b.createdAt < a.createdAt ? -1 : 1;
    });
    return out;
  }

  /**
   * Legacy low-level query: scope/scopeId/type/minConfidence filtering
   * with NO security filtering. Internal callers and tests only —
   * external callers must use `retrieve()` (§43.3).
   */
  query(filter: MemoryQuery): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      this.sweep(entry);
      if (entry.scope !== filter.scope) continue;
      if (filter.scopeId !== undefined && entry.scopeId !== filter.scopeId) continue;
      if (filter.type !== undefined && entry.type !== filter.type) continue;
      if (entry.status === 'RETIRED' && !filter.includeExpired) continue;
      if (entry.status === 'CONTRADICTED' && !filter.includeContradicted) continue;
      if (filter.minConfidence !== undefined && entry.confidence < filter.minConfidence) continue;
      out.push(this.copy(entry));
    }
    out.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt < a.updatedAt ? -1 : 1;
      return b.createdAt < a.createdAt ? -1 : 1;
    });
    return out;
  }

  /**
   * Verify an entry: stamps `lastVerifiedAt` with now and adds +0.1
   * confidence (capped at 1). PROPOSED → VALIDATED; other live statuses
   * → ACTIVE. CONTRADICTED entries are NOT verified away — resolve the
   * contradiction explicitly instead.
   *
   * Note: `verifier` is accepted for the audit trail; a DB-backed store
   * should log it (there is no verifier column on the entry itself).
   * Re-verifying a retired-by-expiry entry revives it, but the next sweep
   * will mark it RETIRED again unless its `expiresAt` is extended.
   */
  verify(id: string, verifier: string): MemoryEntry | undefined {
    void verifier;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.status === 'CONTRADICTED') return this.copy(entry);
    const now = this.nowMs();
    entry.lastVerifiedAt = this.iso(now);
    entry.confidence = round2(Math.min(1, entry.confidence + VERIFY_BOOST));
    entry.status = entry.status === 'PROPOSED' ? 'VALIDATED' : 'ACTIVE';
    entry.updatedAt = this.iso(now);
    return this.copy(entry);
  }

  /** Mark an entry STALE (aging / unverified, deprioritized but kept). */
  markStale(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.status = 'STALE';
    entry.updatedAt = this.iso(this.nowMs());
    return this.copy(entry);
  }

  /** Retire an entry (explicitly withdrawn; hidden from retrieval). */
  retire(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.status = 'RETIRED';
    entry.updatedAt = this.iso(this.nowMs());
    return this.copy(entry);
  }

  /**
   * §43.3 purge: remove every entry whose scopeId matches, and
   * synchronously clean its index/cache/backup references via the
   * registry. The returned PurgeReport is the observable proof that
   * nothing readable remains — "记忆不能保留撤销后不该读取的数据".
   *
   * Note: callers that mirror entries into SQL/audit stores must delete
   * there too (the server purge endpoint does).
   */
  purge(scopeId: string): PurgeReport {
    const removedEntryIds: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.scopeId === scopeId) removedEntryIds.push(id);
    }
    const cleanedRefs = { index: 0, cache: 0, backup: 0 };
    for (const id of removedEntryIds) {
      this.entries.delete(id);
      if (this.registry) {
        const c = this.registry.removeEntry(id);
        cleanedRefs.index += c.index;
        cleanedRefs.cache += c.cache;
        cleanedRefs.backup += c.backup;
      }
    }
    for (const [key, id] of this.byDedupKey) {
      if (removedEntryIds.includes(id)) this.byDedupKey.delete(key);
    }
    const registryClean = this.registry
      ? removedEntryIds.every((id) => this.registry!.refsFor(id).total === 0)
      : true;
    return {
      scopeId,
      removedEntryIds,
      removedCount: removedEntryIds.length,
      cleanedRefs,
      registryClean,
    };
  }

  /**
   * Apply the lifecycle sweep to one entry in place: mark RETIRED when
   * past `expiresAt`, otherwise apply the one-time −0.2 decay once the
   * entry is past half its TTL (measured from `lastVerifiedAt`). The
   * decay checkpoint is persisted by advancing `lastVerifiedAt`, so the
   * penalty applies once per half-TTL window.
   */
  private sweep(entry: MemoryEntry): void {
    if (!entry.expiresAt) return;
    const now = this.nowMs();
    const expiresAt = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    if (now >= expiresAt) {
      if (entry.status !== 'RETIRED') {
        entry.status = 'RETIRED';
        entry.updatedAt = this.iso(now);
      }
      return;
    }
    if (entry.status === 'RETIRED' || entry.status === 'CONTRADICTED') return;
    const anchor = Date.parse(entry.lastVerifiedAt);
    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(anchor) || !Number.isFinite(createdAt)) return;
    const ttl = expiresAt - createdAt;
    if (ttl <= 0) return;
    if (now - anchor >= ttl / 2 && entry.confidence > 0) {
      entry.confidence = round2(Math.max(0, entry.confidence - DECAY_STEP));
      // Checkpoint: the next decay window starts now.
      entry.lastVerifiedAt = this.iso(now);
      entry.updatedAt = this.iso(now);
    }
  }

  /** §43.3 ACL check: '*' grants all; otherwise the requestor needs an overlapping granted scope. */
  private aclAllows(entry: MemoryEntry, requestor: RequestorIdentity): boolean {
    if (entry.accessScope.includes('*')) return true;
    return entry.accessScope.some((s) => requestor.scopes.includes(s));
  }

  private trackRefs(entryId: string): void {
    if (!this.registry) return;
    this.registry.track(entryId, 'index');
    this.registry.track(entryId, 'cache');
    this.registry.track(entryId, 'backup');
  }

  private copy(entry: MemoryEntry): MemoryEntry {
    return {
      ...entry,
      evidenceIds: [...entry.evidenceIds],
      sourceRefs: [...entry.sourceRefs],
      taskRefs: [...entry.taskRefs],
      accessScope: [...entry.accessScope],
      crossProjectReusable: { ...entry.crossProjectReusable },
      supersedes: [...entry.supersedes],
      contradicts: [...entry.contradicts],
    };
  }
}
