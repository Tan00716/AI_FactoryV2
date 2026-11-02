/**
 * Minimal persisted task-run metadata (V3.0 audit round 2, item #10).
 *
 * The live timeline (packages/tasktimeline) is a process-local ring:
 * a server restart clears it. This package persists ONLY run metadata —
 * id, chain label, start/end time, outcome, and per-status step counts.
 * It deliberately stores NO step commands, NO step outputs, NO error
 * text, and NO file paths: those are the fields most likely to carry
 * secrets or workspace content, and view playback does not need them.
 *
 * Boundary, stated wherever this is surfaced: persisted history is a
 * VIEW of past runs, not a re-execution channel. A persisted run cannot
 * be rolled back or re-run from its record (it carries no root path and
 * no step data); re-execution always goes through POST /api/tasks/run
 * with the chain label, i.e. the normal task chain, never old run data.
 *
 * Privacy: the two free-text fields that are persisted (label,
 * rerunFrom) pass through the canonical diagpack redactText (which
 * reuses the @ai-factory/security SECRET_PATTERNS table) before they
 * touch disk. Counts, timestamps, and booleans cannot carry secrets.
 *
 * Retention: entries older than RUN_HISTORY_RETENTION_MS are pruned on
 * load and on record; the file is capped at RUN_HISTORY_MAX_ENTRIES
 * (newest kept). A corrupt file is fail-closed: load() and record()
 * throw and the file is never overwritten; only an explicit clear()
 * removes it (the operator's repair path).
 */

export interface RunStepCounts {
  ok: number;
  failed: number;
  denied: number;
  timeout: number;
  skipped: number;
  superseded: number;
}

/** One persisted run — metadata only, no step data. */
export interface RunHistoryMeta {
  id: string;
  /** Chain label, redacted before persistence. */
  label: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  taskCount: number;
  counts: RunStepCounts;
  coverage: 'full' | 'partial';
  /** Step label the rerun started at, redacted; only for rerun records. */
  rerunOf?: string;
  rerunFrom?: string;
}

export type RunHistoryMetaInput = Omit<RunHistoryMeta, 'label' | 'rerunFrom'> & {
  label: string;
  rerunFrom?: string;
};

/** File name under the server data dir. */
export const RUN_HISTORY_FILE = 'run-history.json';
/** Newest entries kept (storage-bloat pairing with the retention cap). */
export const RUN_HISTORY_MAX_ENTRIES = 200;
/** Entries older than this (by finishedAt) are pruned: 90 days. */
export const RUN_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class RunHistoryCorruptError extends Error {
  readonly code = 'RUN_HISTORY_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'RunHistoryCorruptError';
  }
}
