/**
 * Types for the interactive rebase + stash package (R6-S2).
 *
 * Honest boundaries (also rendered in the UI):
 *  - Only porcelain-level git operations are wrapped. Semantic conflict
 *    resolution stays with the merge3 editor; this package never guesses
 *    how a conflict should be resolved.
 *  - No history rewriting beyond `git rebase -i` (no filter-branch /
 *    filter-repo). Reword messages are single-line in v1.
 *  - A rebase todo is validated before it runs: every hash must be an
 *    ancestor of HEAD reachable from the given base, actions are limited
 *    to pick/reword/squash/fixup/drop, and an empty todo is refused.
 */

/** The five todo actions the UI offers. `exec`/`label`/`reset`/`merge` are rejected. */
export type TodoAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export const TODO_ACTIONS: ReadonlySet<string> = new Set([
  'pick',
  'reword',
  'squash',
  'fixup',
  'drop',
]);

export interface TodoLine {
  action: TodoAction;
  /** Full 40-char commit hash (validated against the repo). */
  hash: string;
  /** Subject line, informational only — git re-reads it from the commit. */
  subject: string;
  /** Single-line replacement message for `reword` lines (v1 limit). */
  message?: string;
}

export interface RebaseCommit {
  hash: string;
  subject: string;
}

export type RebaseStatus =
  | 'completed'
  | 'conflict'
  | 'failed'
  | 'in-progress';

export interface RebaseResult {
  status: RebaseStatus;
  headBefore: string;
  /** HEAD after the operation; equals headBefore when aborted/failed. */
  headAfter: string;
  /** Conflicted paths when status is 'conflict' or 'in-progress'. */
  conflictedFiles: string[];
  /** Raw stderr tail for honest reporting (capped by the caller). */
  stderr: string;
  /** Shadow checkpoint id taken before the rebase (may be absent). */
  checkpointId?: string;
}

export interface StashEntry {
  /** Canonical ref, e.g. `stash@{0}`. */
  index: string;
  /** Numeric position, e.g. 0 for `stash@{0}`. */
  position: number;
  /** Full stash message as git reports it. */
  message: string;
}

export type StashApplyOutcome = 'applied' | 'conflict' | 'failed';

export interface StashApplyResult {
  outcome: StashApplyOutcome;
  conflictedFiles: string[];
  stderr: string;
}

/** Thrown by every function in this package on git/validation failure. */
export class RebaseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RebaseError';
    this.code = code;
  }
}
