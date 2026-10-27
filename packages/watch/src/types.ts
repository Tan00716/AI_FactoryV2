/**
 * @ai-factory/watch — types (round-6 task R6-S3: file-watch triggers).
 *
 * A watch rule is a pure trigger declaration: "when a file matching one of
 * these globs changes under a project root, run this tasks.json chain".
 * The package never executes anything itself — execution is the server
 * route's job, which reuses the task runner's exec safety policy.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - This is a trigger only, not incremental compilation: every fire runs
 *    the whole declared chain from scratch.
 *  - Watchers live in the server process. A server restart drops them;
 *    enabled rules must be re-activated (POST /api/watch/activate).
 *  - One rule's chain runs are serialized: a fire arriving while the
 *    previous run is still executing is queued (at most one pending
 *    trigger per rule; further fires coalesce into it).
 */

/** The only action type in v1: run a tasks.json chain by label. */
export type WatchActionType = 'task';

export interface WatchAction {
  type: WatchActionType;
  /** tasks.json label (with its dependsOn chain). */
  label: string;
}

export interface WatchRule {
  id: string;
  name: string;
  /** Glob patterns, matched against the project-root-relative posix path. */
  globs: string[];
  action: WatchAction;
  /** Debounce window in ms; clamped to [100, 60000] at validation. */
  debounceMs: number;
  enabled: boolean;
}

export type WatchChangeKind = 'change' | 'create' | 'delete';

/** One debounced, coalesced fire: the rule plus every file seen in the window. */
export interface WatchFire {
  rule: WatchRule;
  /** Project-root-relative posix paths, deduplicated, sorted. */
  files: string[];
  /** True when the window saw more than BURST_FILE_THRESHOLD changes. */
  burst: boolean;
  firedAt: string;
}

/** Outcome of one triggered chain run, recorded for the trigger history. */
export interface WatchTriggerRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  /** Project root the rule ran under (absolute, server-jailed). */
  root: string;
  files: string[];
  burst: boolean;
  startedAt: string;
  finishedAt: string;
  /** 'ok' | 'failed' | 'denied' | 'error' — mirrors the chain outcome. */
  status: string;
  chainOk: boolean;
  stoppedAt: string | null;
  /** Failing task labels, if any. */
  failedLabels: string[];
  error: string | null;
}

/** Limits (fail-closed: exceeding any of them refuses the operation). */
export const MAX_RULES_PER_ROOT = 50;
export const MAX_GLOBS_PER_RULE = 20;
export const MIN_DEBOUNCE_MS = 100;
export const MAX_DEBOUNCE_MS = 60000;
export const DEFAULT_DEBOUNCE_MS = 500;
/** Changes beyond this in one debounce window collapse into a burst fire. */
export const BURST_FILE_THRESHOLD = 200;
/** Watched directories per active rule (fs.watch handles, not files). */
export const MAX_WATCHED_DIRS = 5000;
export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_LABEL_LENGTH = 200;
