/**
 * R6-S4 background task queue — shared types.
 *
 * A job is one tasks.json label chain (R5-S2) submitted for background
 * execution. Parallelism lives BETWEEN jobs: within a job, chain tasks
 * run sequentially in dependency (topological) order — the queue does
 * no cross-job dependency scheduling, and a job's DAG stays inside the
 * job. This package is a pure state machine: it never spawns processes.
 * The server route owns spawning, process-group kill, and pumping.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. Jobs are process-local: a server restart drops queued and running
 *     jobs (running children are orphaned only if the server dies
 *     without cleanup — the route kills groups on cancel/timeout, and
 *     on shutdown it best-effort kills tracked children).
 *  2. The per-job log is a capped sliding window (LOG_CAP_BYTES): when
 *     output exceeds the cap, the oldest bytes are dropped and
 *     `logTruncated` is set. The log is NOT a complete transcript.
 *  3. Cancel of a running job is a kill request, not a guarantee of
 *     instant death: the job reaches 'cancelled' when its process group
 *     actually exits (or the kill is confirmed failed, in which case
 *     the job is marked 'failed' with an error, never silently kept).
 */

/** Terminal-visible job lifecycle. 'cancelling' is not a stored status: a
 *  running job with cancelRequested=true still reports 'running' until
 *  its process group exits, then it becomes 'cancelled'. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Outcome recorded when a job finishes. */
export type JobOutcome = 'succeeded' | 'failed' | 'cancelled';

/** Per-task outcome inside a job chain (mirrors R5-S2 TaskRunResult). */
export type JobTaskStatus = 'ok' | 'failed' | 'denied' | 'timeout' | 'cancelled' | 'skipped';

/** One task's outcome inside a job. */
export interface JobTaskResult {
  label: string;
  status: JobTaskStatus;
  exitCode: number | null;
  durationMs: number;
  diagnosticsAdded: number;
  error?: string;
}

/** A parsed problem-matcher diagnostic kept on the job (capped). */
export interface JobDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  matcher: string;
}

/** Lightweight job view for list endpoints (no log bytes). */
export interface JobSummary {
  id: string;
  label: string;
  chain: string[];
  status: JobStatus;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  currentTask: string | null;
  completedTaskCount: number;
  taskCount: number;
  diagnosticsAdded: number;
  logTruncated: boolean;
  error?: string;
}

/** Full job record (server-side only; the log endpoint serves the log). */
export interface QueueJob extends JobSummary {
  log: string;
  tasks: JobTaskResult[];
  diagnostics: JobDiagnostic[];
  /** Project root the job was submitted against (for audit, not echoed). */
  root: string;
  projectId: string;
}

/** Queue configuration. */
export interface QueueConfig {
  maxConcurrency: number;
}

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 32;
export const DEFAULT_MAX_CONCURRENCY = 4;
/** Per-job log cap in bytes (sliding window, oldest bytes dropped). */
export const LOG_CAP_BYTES = 512_000;
/** Per-job diagnostic cap (oldest dropped). */
export const MAX_JOB_DIAGNOSTICS = 200;
/** Max jobs retained in memory (oldest terminal jobs evicted). */
export const MAX_JOBS = 200;
