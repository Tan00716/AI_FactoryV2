/**
 * Memory engine domain types — SPEC v2 §43 (Structured Memory Engine).
 *
 * §43.1 scopes: employee / project / organization / task / system.
 * Memory is separate from external Knowledge; System Memory carries no
 * project secrets. Every record carries Scope/ACL, Data Classification and
 * cross-project reuse conditions.
 *
 * §43.2 schema: memory_id, type, content/structured_payload, source_refs,
 * evidence_refs, author_id, task/requirement refs, applicability,
 * confidence_kind/value, created_at, last_verified_at, expires_at, status,
 * supersedes/contradicts, embedding/index_version, access_scope.
 * Types: FACT, DECISION, PATTERN, LESSON, FAILURE, PREFERENCE, CONSTRAINT,
 * SOLUTION, KNOWN_ISSUE. Statuses: PROPOSED, VALIDATED, ACTIVE, STALE,
 * CONTRADICTED, RETIRED.
 *
 * §43.3 read/write: scope/security filter FIRST, then semantic
 * retrieval/ranking — never a full-corpus vector search with results merely
 * hidden in the UI. Source, evidence, freshness and applicability affect
 * retrieval; model self-confidence alone cannot promote a conclusion to
 * fact. Contradictory records conflict: the authoritative source is
 * updated and re-verified (not simply newest-date or highest-score wins).
 * Fact expiry, permission revocation and project deletion must
 * synchronously clean summaries, vectors, cache and backup retention.
 *
 * §43.4 prohibitions: no raw secrets/tokens/irrelevant PII copies; no
 * "next time we can skip approval" conclusions from successful deploys;
 * never treat a Manager's claim as an actual test result. Memory can never
 * grant permissions, change AC or override Policy.
 */

/** §43.1 — the five memory scopes. */
export type MemoryScope =
  | 'employee' // what this AI employee learned
  | 'project' // what the project learned
  | 'organization' // how the AI company operates
  | 'task' // what happened during one task
  | 'system'; // general AI engineering knowledge

/** §43.2 — structured memory entry types. */
export type MemoryType =
  | 'Fact'
  | 'Decision'
  | 'Pattern'
  | 'Lesson'
  | 'Failure'
  | 'Preference'
  | 'Constraint'
  | 'Solution'
  | 'KnownIssue';

/** §43.2 — entry lifecycle status (v2; replaces the v1 ACTIVE/DEPRECATED/EXPIRED set). */
export type MemoryStatus =
  | 'PROPOSED' // written but not yet validated (e.g. contradicts an ACTIVE entry)
  | 'VALIDATED' // evidence-checked, not yet in active use
  | 'ACTIVE' // trusted and retrievable
  | 'STALE' // aging / unverified, kept but deprioritized
  | 'CONTRADICTED' // superseded by a conflicting entry, pending resolution
  | 'RETIRED'; // expired or explicitly withdrawn; hidden from retrieval

/** §43.1 — data classification. Higher rank = more sensitive. */
export type DataClassification = 'public' | 'internal' | 'confidential' | 'secret';

/** Classification sensitivity rank; a requestor may read entries at or below their clearance. */
export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

/**
 * §43.1 — cross-project reuse conditions. An entry from project A is only
 * visible to project B retrievals when `allowed` is true (and the
 * requestor passes the ACL + classification filters); `conditions`
 * records the terms, e.g. 'sanitized, no customer identifiers'.
 */
export interface CrossProjectReusable {
  allowed: boolean;
  conditions?: string;
}

/**
 * §43.2 confidence_kind. Per §43.3, model self-confidence alone cannot
 * promote a conclusion to fact — the kind is recorded so retrieval can
 * require evidence-backed or human-verified confidence where it matters.
 */
export type ConfidenceKind =
  | 'model-self-assessed'
  | 'evidence-backed'
  | 'human-verified'
  | 'evaluation-derived';

/**
 * §43.2 — one structured memory entry (v2 schema).
 *
 * All timestamps are ISO-8601 strings. `expiresAt === null` means the entry
 * never expires. `confidence` is the 0..1 confidence_value; the store
 * auto-degrades it past half TTL and `verify()` restores it.
 *
 * Security fields:
 *  - `accessScope`: ACL entries such as 'project:acme', 'employee:e-1',
 *    'organization:o-1'. `'*'` means visible to every requestor.
 *    `retrieve()` filters on this BEFORE any retrieval/ranking (§43.3).
 *  - `dataClassification`: requestor clearance must dominate the entry's
 *    classification, otherwise the entry is not returned at all (§43.3).
 *  - `crossProjectReusable`: gates visibility across project boundaries.
 */
export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Id of the owning entity, e.g. employee id, project id, task id. */
  scopeId: string;
  type: MemoryType;
  title: string;
  content: string;
  /** Primary source label, e.g. 'evaluation:task-101', 'human', 'skill:deploy'. */
  source: string;
  /** All source references for this entry (§43.2 source_refs). */
  sourceRefs: string[];
  /** §43.2 confidence_value, 0..1. Decays with age; see MemoryStore. */
  confidence: number;
  /** §43.2 confidence_kind. */
  confidenceKind: ConfidenceKind;
  /** Who/what created the entry: employee id, 'evaluation-engine', 'human', … */
  createdBy: string;
  /** Ids of supporting evidence records (§43.2 evidence_refs). */
  evidenceIds: string[];
  /** Task / requirement references (§43.2), e.g. ['TASK-101', 'REQ-001@2']. */
  taskRefs: string[];
  /** Last time the entry was verified; the decay clock is anchored here. */
  lastVerifiedAt: string;
  /** Who this memory applies to beyond its own scope row, e.g. 'project:acme'. */
  applicableScope: string;
  /** §43.1 ACL. See the security-fields doc above. */
  accessScope: string[];
  /** §43.1 data classification. */
  dataClassification: DataClassification;
  /** §43.1 cross-project reuse conditions. */
  crossProjectReusable: CrossProjectReusable;
  /** ISO timestamp, or null = never expires. */
  expiresAt: string | null;
  status: MemoryStatus;
  /** Ids this entry supersedes (§43.2). */
  supersedes: string[];
  /** Ids this entry contradicts (§43.2); contradictions are resolved via resolveContradiction. */
  contradicts: string[];
  /** Embedding/index version (§43.2). */
  indexVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for `MemoryStore.write` — identity and bookkeeping are assigned. */
export interface NewMemoryEntry {
  scope: MemoryScope;
  scopeId: string;
  type: MemoryType;
  title: string;
  content: string;
  source: string;
  /** 0..1; clamped by the store. */
  confidence: number;
  createdBy: string;
  evidenceIds?: string[];
  sourceRefs?: string[];
  taskRefs?: string[];
  lastVerifiedAt?: string;
  applicableScope?: string;
  /**
   * §43.1 ACL. Defaults to [`<scope>:<scopeId>`]; `system` scope defaults
   * to `['*']` (visible to all requestors — system memory carries no
   * project secrets).
   */
  accessScope?: string[];
  /** Defaults to 'internal'. */
  dataClassification?: DataClassification;
  /** Defaults to `{ allowed: dataClassification === 'public' }`. */
  crossProjectReusable?: CrossProjectReusable;
  /** Defaults to 'model-self-assessed'. */
  confidenceKind?: ConfidenceKind;
  /** Defaults to null (never expires). */
  expiresAt?: string | null;
  supersedes?: string[];
  /**
   * Ids of ACTIVE entries this write contradicts. Each contradicted entry
   * is marked CONTRADICTED and this entry is stored as PROPOSED (§43.3).
   */
  contradicts?: string[];
  /** Defaults to 'v1'. */
  indexVersion?: string;
}

/** Filters for `MemoryStore.query` (legacy low-level path; no security filtering). */
export interface MemoryQuery {
  scope: MemoryScope;
  scopeId?: string;
  type?: MemoryType;
  /** Keep only entries with effective confidence >= this value. */
  minConfidence?: number;
  /** Default false: expired entries are auto-marked RETIRED and hidden. */
  includeExpired?: boolean;
  /** Default false: CONTRADICTED entries are hidden. */
  includeContradicted?: boolean;
}

/**
 * §43.3 — identity of the party requesting retrieval. The requestor's
 * granted scopes and clearance are checked BEFORE any retrieval/ranking;
 * unauthorized entries are never returned (not merely hidden in UI).
 */
export interface RequestorIdentity {
  /** Authenticated requestor id, e.g. employee id. */
  id: string;
  /** Granted scopes, e.g. ['project:acme', 'employee:backend-01']. */
  scopes: string[];
  /** Maximum classification the requestor may read. */
  clearance: DataClassification;
}

/** Filters for `MemoryStore.retrieve` — the §43.3 secure retrieval path. */
export interface MemoryRetrieveQuery {
  scope: MemoryScope;
  /**
   * When set, only this scopeId's entries are returned directly; entries
   * from other scopeIds pass only when crossProjectReusable.allowed.
   * When omitted, every scopeId the requestor is authorized for is
   * searched (still ACL + classification filtered first).
   */
  scopeId?: string;
  type?: MemoryType;
  /** Keep only entries with effective confidence >= this value. */
  minConfidence?: number;
  /** Default false: RETIRED entries are hidden. */
  includeRetired?: boolean;
  /** Default false: CONTRADICTED entries are hidden. */
  includeContradicted?: boolean;
}

/** Result of `MemoryStore.purge` / `MemoryRefRegistry` cleanup. */
export interface PurgeReport {
  scopeId: string;
  /** Ids of the entries removed from the store. */
  removedEntryIds: string[];
  removedCount: number;
  /** How many references were cleaned per downstream system. */
  cleanedRefs: { index: number; cache: number; backup: number };
  /** True when the registry holds zero references for every removed id. */
  registryClean: boolean;
}
