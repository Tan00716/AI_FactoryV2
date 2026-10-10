/**
 * @ai-factory/recovery — shared types (spec §77–§78).
 *
 *  - FailureType: the 12 failure types from §78
 *  - RecoveryStrategy: the 9 recovery strategies from §78
 *  - SnapshotManifest: immutable snapshot descriptor
 */

/** The 12 failure types from spec §78. */
export type FailureType =
  | 'MODEL_ERROR'
  | 'TOOL_ERROR'
  | 'NETWORK_ERROR'
  | 'AUTH_ERROR'
  | 'BUILD_ERROR'
  | 'TEST_ERROR'
  | 'CODE_ERROR'
  | 'ENVIRONMENT_ERROR'
  | 'PERMISSION_ERROR'
  | 'RESOURCE_LIMIT'
  | 'LOOP_STAGNATION'
  | 'UNKNOWN';

export const ALL_FAILURE_TYPES: readonly FailureType[] = [
  'MODEL_ERROR',
  'TOOL_ERROR',
  'NETWORK_ERROR',
  'AUTH_ERROR',
  'BUILD_ERROR',
  'TEST_ERROR',
  'CODE_ERROR',
  'ENVIRONMENT_ERROR',
  'PERMISSION_ERROR',
  'RESOURCE_LIMIT',
  'LOOP_STAGNATION',
  'UNKNOWN',
];

/** The 9 recovery strategies from spec §78. */
export type RecoveryStrategy =
  | 'retry'
  | 'change-model'
  | 'change-agent'
  | 'create-specialist'
  | 'revert-change'
  | 'snapshot-restore'
  | 'env-restart'
  | 'ask-human'
  | 'abort';

export const ALL_RECOVERY_STRATEGIES: readonly RecoveryStrategy[] = [
  'retry',
  'change-model',
  'change-agent',
  'create-specialist',
  'revert-change',
  'snapshot-restore',
  'env-restart',
  'ask-human',
  'abort',
];

/** One file captured in a snapshot. */
export interface SnapshotFile {
  /** Path relative to the snapshotted workspace directory, posix-style. */
  path: string;
  /** sha256 hex of the file content. */
  hash: string;
  /** Byte size of the file content. */
  size: number;
}

/**
 * Immutable snapshot descriptor. Written once by take() and sealed;
 * restore/verify refuse to touch an unsealed snapshot.
 */
export interface SnapshotManifest {
  id: string;
  createdAt: string;
  /** Absolute path of the workspace directory this was taken from. */
  workspaceDir: string;
  /** Optional database file captured alongside the workspace. */
  dbPath: string | null;
  dbHash: string | null;
  files: SnapshotFile[];
  /** Human tag, e.g. "before production deployment". */
  tag?: string;
  /** Set by seal(); a sealed snapshot is immutable. */
  sealed: boolean;
}

/** Injectible clock for deterministic time in tests. */
export interface Clock {
  now(): number;
}

export function isoNow(clock?: Clock): string {
  return new Date(clock ? clock.now() : Date.now()).toISOString();
}
