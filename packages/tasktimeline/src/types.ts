/**
 * V3-#7 Cascade-style task timeline — pure data model.
 *
 * A timeline is the per-step record of one tasks.json chain run: one card
 * per step (label, command, status, exit code, duration, capped output,
 * diagnostics, error). Steps the chain never reached (fail-closed stop)
 * are recorded explicitly as 'skipped', never invented as run. Steps whose
 * command is unknown to the planner are recorded with command=null and
 * coverage 'partial' — a gap is shown as a gap, not papered over.
 *
 * Rollback semantics (read before extending): rollback to step N does NOT
 * delete or rewrite history. Steps after N are marked 'superseded' and the
 * original results stay in the record; the audit chain therefore stays
 * continuous. Rollback can only move the supersede boundary backwards
 * (to an earlier step); it can never un-supersede a step. File-level
 * revert is a separate action through the existing shadow-checkpoint
 * restore endpoint — this package never touches the filesystem.
 *
 * HONEST BOUNDARIES:
 *  1. Timeline output is capped at TIMELINE_OUTPUT_CAP_BYTES per step
 *     (the chain runner itself caps at 2MB); outputDigest is the SHA-256
 *     of the STORED (capped) output bytes, i.e. a digest of the captured
 *     record, not of a build artifact. It is labelled as such wherever
 *     surfaced.
 *  2. A timeline run is process-local (same in-memory ring as the run
 *     records it replaces); a server restart clears it.
 *  3. This package is server-only (node:crypto). The desktop consumes it
 *     exclusively through the /api/tasks/runs HTTP API, never by import.
 */

export type TimelineStepStatus =
  | 'ok'
  | 'failed'
  | 'denied'
  | 'timeout'
  | 'skipped'
  | 'superseded';

/** One executed (or planned-but-unrun) chain step, as recorded. */
export interface TimelineStepInput {
  label: string;
  status: 'ok' | 'failed' | 'denied' | 'timeout' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  diagnosticsAdded: number;
  matchRate: number;
  error?: string;
  notes?: string[];
}

/** One step card in a timeline. */
export interface TimelineStep {
  index: number;
  label: string;
  /** Declared command (command + args joined); null when the planner did not know this step. */
  command: string | null;
  status: TimelineStepStatus;
  exitCode: number | null;
  durationMs: number;
  /** Stored output, capped at TIMELINE_OUTPUT_CAP_BYTES. */
  output: string;
  /** Bytes of the original (pre-cap) output. */
  outputBytes: number;
  /** True when the stored output was capped (or the runner already truncated it). */
  outputTruncated: boolean;
  /** SHA-256 hex of the stored output bytes (record digest, not an artifact digest). */
  outputDigest: string;
  diagnosticsAdded: number;
  matchRate: number;
  error?: string;
  notes?: string[];
  /** ISO timestamp when this step was superseded by a rollback, else null. */
  supersededAt: string | null;
}

/** One chain run's timeline. */
export interface TimelineRun {
  id: string;
  /** Chain label as requested. */
  label: string;
  ok: boolean;
  stoppedAt: string | null;
  startedAt: string;
  finishedAt: string;
  steps: TimelineStep[];
  /** 'full' when every step's command is known; 'partial' when any step is unknown. */
  coverage: 'full' | 'partial';
  coverageNote?: string;
  /** Label of the step rolled back to, or null when no rollback happened. */
  supersededFrom: string | null;
  /** ISO timestamp of the latest rollback, or null. */
  supersededAt: string | null;
  rollbackCount: number;
  /** Id of the run this run re-ran from, when this run is a rerun. */
  rerunOf?: string;
  /** Step label the rerun started at. */
  rerunFrom?: string;
  /** Task id to look shadow checkpoints up by (== chain label). */
  checkpointTaskId: string;
}

/** Per-step output cap for timeline storage (the runner caps at 2MB). */
export const TIMELINE_OUTPUT_CAP_BYTES = 32 * 1024;

/** Error thrown by timeline operations; `code` is the API error code. */
export class TimelineError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TimelineError';
    this.code = code;
  }
}
