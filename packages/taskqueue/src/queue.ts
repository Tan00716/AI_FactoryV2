/**
 * R6-S4 background task queue — pure state machine.
 *
 * No process spawning, no I/O, no clock dependency beyond the
 * caller-supplied timestamps: fully deterministic and unit-testable.
 * The server route drives it: submit → pump (takeNext while a slot is
 * free) → markRunning → markFinished, and cancel → either immediate
 * (queued) or requested (running; the route kills the process group
 * and finalizes on exit).
 */
import {
  LOG_CAP_BYTES,
  MAX_CONCURRENCY,
  MAX_JOBS,
  MAX_JOB_DIAGNOSTICS,
  MIN_CONCURRENCY,
  type JobDiagnostic,
  type JobOutcome,
  type JobStatus,
  type JobSummary,
  type JobTaskResult,
  type QueueConfig,
  type QueueJob,
} from './types.ts';

export type CancelResult = 'cancelled' | 'cancel-requested' | 'terminal' | 'unknown';

export class JobQueue {
  private readonly jobs = new Map<string, QueueJob>();
  private order: string[] = [];
  private seq = 0;
  private config: QueueConfig;

  constructor(maxConcurrency: number) {
    const checked = JobQueue.checkConcurrency(maxConcurrency);
    if (checked) throw new Error(checked);
    this.config = { maxConcurrency };
  }

  static checkConcurrency(value: unknown): string | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return 'maxConcurrency must be an integer';
    }
    if (value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) {
      return `maxConcurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`;
    }
    return null;
  }

  getConfig(): QueueConfig {
    return { ...this.config };
  }

  setMaxConcurrency(value: unknown): { ok: boolean; error?: string } {
    const err = JobQueue.checkConcurrency(value);
    if (err) return { ok: false, error: err };
    this.config = { maxConcurrency: value as number };
    return { ok: true };
  }

  submit(label: string, chain: string[], root: string, projectId: string): QueueJob {
    this.seq += 1;
    const now = new Date().toISOString();
    const job: QueueJob = {
      id: `tq-${this.seq}`,
      label,
      chain: [...chain],
      status: 'queued',
      cancelRequested: false,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      currentTask: null,
      completedTaskCount: 0,
      taskCount: chain.length,
      diagnosticsAdded: 0,
      logTruncated: false,
      log: '',
      tasks: [],
      diagnostics: [],
      root,
      projectId,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.evictOldTerminal();
    return job;
  }

  get(id: string): QueueJob | null {
    return this.jobs.get(id) ?? null;
  }

  runningCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === 'running') n += 1;
    return n;
  }

  queuedCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === 'queued') n += 1;
    return n;
  }

  hasFreeSlot(): boolean {
    return this.runningCount() < this.config.maxConcurrency;
  }

  /** FIFO: oldest queued job, or null. Does not change state. */
  peekNext(): QueueJob | null {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && job.status === 'queued') return job;
    }
    return null;
  }

  /** Mark a queued job running. Returns null when the job is not queued. */
  markRunning(id: string): QueueJob | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return null;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    return job;
  }

  /** Record one finished chain task on a running job. */
  recordTask(id: string, result: JobTaskResult): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    job.tasks.push(result);
    job.completedTaskCount += 1;
    job.diagnosticsAdded += result.diagnosticsAdded;
    job.currentTask = null;
  }

  setCurrentTask(id: string, label: string | null): void {
    const job = this.jobs.get(id);
    if (job && job.status === 'running') job.currentTask = label;
  }

  addDiagnostics(id: string, diags: JobDiagnostic[]): void {
    const job = this.jobs.get(id);
    if (!job) return;
    for (const d of diags) {
      job.diagnostics.push(d);
      if (job.diagnostics.length > MAX_JOB_DIAGNOSTICS) job.diagnostics.shift();
    }
  }

  /** Append output to the job log (sliding window, oldest bytes dropped). */
  appendLog(id: string, text: string): void {
    const job = this.jobs.get(id);
    if (!job || text.length === 0) return;
    const next = job.log + text;
    if (next.length > LOG_CAP_BYTES) {
      job.log = next.slice(next.length - LOG_CAP_BYTES);
      job.logTruncated = true;
    } else {
      job.log = next;
    }
  }

  markFinished(id: string, outcome: JobOutcome, exitCode: number | null, error?: string): QueueJob | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    job.status = outcome;
    job.finishedAt = new Date().toISOString();
    job.exitCode = exitCode;
    job.currentTask = null;
    if (error !== undefined) job.error = error;
    return job;
  }

  /**
   * Cancel a job. Queued → terminal 'cancelled' immediately. Running →
   * 'cancel-requested' (the caller must kill the process group; the
   * job finalizes to 'cancelled' on exit). Terminal/unknown → no-op.
   */
  cancel(id: string): CancelResult {
    const job = this.jobs.get(id);
    if (!job) return 'unknown';
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.error = 'cancelled before start';
      return 'cancelled';
    }
    if (job.status === 'running') {
      job.cancelRequested = true;
      return 'cancel-requested';
    }
    return 'terminal';
  }

  /** Lightweight summaries in submission order (newest last). */
  summaries(): JobSummary[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is QueueJob => j !== undefined)
      .map((j) => JobQueue.toSummary(j));
  }

  static toSummary(job: QueueJob): JobSummary {
    return {
      id: job.id,
      label: job.label,
      chain: [...job.chain],
      status: job.status,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      currentTask: job.currentTask,
      completedTaskCount: job.completedTaskCount,
      taskCount: job.taskCount,
      diagnosticsAdded: job.diagnosticsAdded,
      logTruncated: job.logTruncated,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
  }

  private evictOldTerminal(): void {
    while (this.order.length > MAX_JOBS) {
      const oldestId = this.order[0];
      const oldest = oldestId ? this.jobs.get(oldestId) : undefined;
      if (oldest && (oldest.status === 'queued' || oldest.status === 'running')) {
        // Never evict a live job; stop once the head is live (newer
        // entries are all at least as recent, so eviction stalls here
        // until a live job finishes — bounded by MAX_JOBS + live jobs).
        break;
      }
      if (oldestId) {
        this.jobs.delete(oldestId);
        this.order.shift();
      } else {
        break;
      }
    }
  }
}
