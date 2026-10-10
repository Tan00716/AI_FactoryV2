/**
 * @ai-factory/knowledge — shared types (spec §50–§53).
 *
 * Clock is injectable (`{ now: () => number }`) for deterministic tests;
 * `systemClock` is the production default.
 */

/** Injectable clock for deterministic timestamps in tests. */
export interface Clock {
  now: () => number;
}

/** Production clock: wall time. */
export const systemClock: Clock = { now: () => Date.now() };

/* ------------------------------------------------------------------ */
/* §50 Knowledge hierarchy                                             */
/* ------------------------------------------------------------------ */

/** Knowledge hierarchy levels, most-general first [§50]. */
export type ScopeLevel = 'GLOBAL' | 'ORGANIZATION' | 'PROJECT' | 'EMPLOYEE' | 'TASK';

export const SCOPE_LEVELS: readonly ScopeLevel[] = [
  'GLOBAL',
  'ORGANIZATION',
  'PROJECT',
  'EMPLOYEE',
  'TASK',
];

/** Higher number = more specific. Used to rank query hits. */
export const SCOPE_SPECIFICITY: Record<ScopeLevel, number> = {
  GLOBAL: 0,
  ORGANIZATION: 1,
  PROJECT: 2,
  EMPLOYEE: 3,
  TASK: 4,
};

/** Where a knowledge item lives in the hierarchy. */
export interface KnowledgeScope {
  level: ScopeLevel;
  organizationId?: string;
  projectId?: string;
  employeeId?: string;
  taskId?: string;
}

/** The caller's position in the hierarchy when querying. */
export interface QueryContext {
  organizationId?: string;
  projectId?: string;
  employeeId?: string;
  taskId?: string;
}

/* ------------------------------------------------------------------ */
/* §53 Lifecycle                                                       */
/* ------------------------------------------------------------------ */

/** Knowledge lifecycle states [§53]. */
export type LifecycleState =
  | 'DISCOVERED'
  | 'UNVERIFIED'
  | 'VALIDATED'
  | 'EVALUATED'
  | 'APPROVED'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'RETIRED';

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'DISCOVERED',
  'UNVERIFIED',
  'VALIDATED',
  'EVALUATED',
  'APPROVED',
  'ACTIVE',
  'DEPRECATED',
  'RETIRED',
];

/* ------------------------------------------------------------------ */
/* §51 Knowledge sources                                               */
/* ------------------------------------------------------------------ */

/** Allowed knowledge source types [§51]. */
export type SourceType =
  | 'official_spec'
  | 'official_docs'
  | 'official_release'
  | 'primary_article'
  | 'research'
  | 'community';

/** Priority order, highest first [§51]. */
export const SOURCE_PRIORITY: readonly SourceType[] = [
  'official_spec',
  'official_docs',
  'official_release',
  'primary_article',
  'research',
  'community',
];

export interface KnowledgeSource {
  type: SourceType;
  /** Human-readable name, e.g. "Node.js LTS release notes". */
  name: string;
  /** Canonical URL of the source material (every record carries one). */
  url?: string;
  /** Publisher / author of the source material. */
  publisher?: string;
  /** When this source record was retrieved (ms epoch). */
  retrievedAt: number;
  /** When the source material itself was published (ms epoch). */
  publishedAt?: number;
  /** Spec/product version the material applies to, e.g. "node>=20". */
  applicableVersion?: string;
  /** Content hash of the retrieved material (dedup + tamper evidence). */
  contentHash?: string;
  /** What part of the source was cited, e.g. "§3.2 release notes". */
  citationScope?: string;
  /** License of the source material; required for redistribution. */
  license?: string;
}

/** Source metadata fields every knowledge record should carry [§44]. */
export const SOURCE_METADATA_FIELDS = [
  'url',
  'publisher',
  'retrievedAt',
  'publishedAt',
  'applicableVersion',
  'contentHash',
  'citationScope',
  'license',
] as const;

export type SourceMetadataField = (typeof SOURCE_METADATA_FIELDS)[number];

/**
 * List the source metadata fields missing from a knowledge record.
 * A missing URL/publisher or an unavailable source must be marked on the
 * Update Feed rather than silently trusted [§44].
 */
export function missingSourceMetadata(source: KnowledgeSource): SourceMetadataField[] {
  const missing: SourceMetadataField[] = [];
  for (const field of SOURCE_METADATA_FIELDS) {
    const v = source[field];
    if (v === undefined || v === null || v === '') missing.push(field);
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* Knowledge item                                                      */
/* ------------------------------------------------------------------ */

export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  tags: string[];
  scope: KnowledgeScope;
  source: KnowledgeSource;
  state: LifecycleState;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** One recorded lifecycle transition, with timestamp and actor [§53]. */
export interface LifecycleTransition {
  itemId: string;
  from: LifecycleState;
  to: LifecycleState;
  at: number;
  actor: string;
  note?: string;
}

/** A query result: the item plus which hierarchy level matched. */
export interface QueryHit {
  item: KnowledgeItem;
  matchedScope: KnowledgeScope;
  /** Specificity of the matched scope; higher = more specific. */
  specificity: number;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class LifecycleError extends Error {
  readonly code = 'ILLEGAL_LIFECYCLE_TRANSITION';
  constructor(
    message: string,
    readonly itemId: string,
    readonly from: LifecycleState,
    readonly attempted: LifecycleState,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export class ScoutError extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly stage: string,
    readonly records: unknown[],
    code = 'SCOUT_STAGE_FAILED',
  ) {
    super(message);
    this.code = code;
    this.name = 'ScoutError';
  }
}
