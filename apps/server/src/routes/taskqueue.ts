/**
 * Background task queue routes (round-6 task R6-S4) — parallel/queued
 * execution of R5-S2 tasks.json label chains.
 *
 *   POST /api/taskqueue/submit          { label, root?, projectId? }
 *   GET  /api/taskqueue/jobs            summaries + config + counts
 *   GET  /api/taskqueue/jobs/:id        summary + per-task results + diagnostics
 *   GET  /api/taskqueue/jobs/:id/log    capped log window
 *   POST /api/taskqueue/jobs/:id/cancel { actor? }
 *   GET  /api/taskqueue/config
 *   PUT  /api/taskqueue/config          { maxConcurrency }
 *
 * Execution safety: a queue job runs the SAME channel as the synchronous
 * runner — deny patterns + binary whitelist + argv guards
 * (checkCommandPolicy), the control-plane data-dir guard, the workspace
 * cwd jail, and the additive-only env rules from the tasks.json parser.
 * No new execution channel is opened. The only difference from the sync
 * runner is lifecycle: jobs run in the background under a concurrency
 * cap, and a running job can be cancelled (POSIX process-group kill).
 *
 * Within a job, chain tasks run SEQUENTIALLY in dependency
 * (topological) order — parallelism lives between jobs, never inside
 * one job's DAG, and the queue does no cross-job dependency scheduling.
 * Problem-matcher output is parsed with the project's matchers but
 * stored ON THE JOB (capped), never into the global diagnostics store,
 * so one job's parse never clobbers another job's or the sync runner's
 * 'tasks' snapshot: diagnostics are partitioned per job.
 *
 * Dual-mode rule: this module must not value-import src-relative
 * extensionless modules (tests import it straight from src with
 * type-stripping). All cross-module seams arrive via setTaskQueueDeps,
 * wired by index.ts. Package imports (@ai-factory/tasks,
 * @ai-factory/taskqueue) are fine.
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Jobs are process-local: a server restart drops queued and running
 *    jobs; there is no persistence and no cross-restart recovery.
 *  - Default maxConcurrency is the CPU count (clamped 1–16); PUT accepts
 *    1–32. Over the cap, jobs queue FIFO.
 *  - Cancel kills the whole POSIX process group (detached spawn); on
 *    Windows the negative-pid kill is unavailable and the fallback is
 *    a direct child kill (grandchildren may survive — documented, not
 *    hidden).
 *  - The per-job log is a 512KB sliding window (oldest bytes dropped,
 *    flagged), not a complete transcript.
 *  - A job's chain runs sequentially even when the chain declares
 *    parallel dependsOn branches (the sync runner parallelizes them;
 *    the queue does not — parallelism is between jobs).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  flattenPlan,
  parseTasksJson,
  planRun,
  shellCommandLine,
  type TaskDef,
} from '@ai-factory/tasks';
import {
  JobQueue,
  type JobDiagnostic,
  type JobSummary,
  type JobTaskResult,
} from '@ai-factory/taskqueue';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import type { RouteContext } from './context';
import type { ParseStats, ProblemDiagnostic, ProblemMatcherDef } from '../problem-matchers';

const PREFIX = '/api/taskqueue';
const TASKS_FILE = '.ai-factory/tasks.json';
const MAX_FILE_BYTES = 512_000;
const OUTPUT_CAP_BYTES = 2_000_000;
const DEFAULT_CONCURRENCY = Math.min(16, Math.max(1, cpus().length));

class TaskQueueRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'TaskQueueRouteError';
    this.code = code;
    this.status = status;
  }
}

/** All policy/cross-module seams, injected once by index.ts at boot. */
export interface TaskQueueDeps {
  /** Jail a requested project root (throws on escape). */
  resolveRoot: (root?: string) => string;
  /** Exec safety policy: deny patterns + whitelist + argv guards. Throws on deny. */
  checkCommandPolicy: (command: string) => string[];
  /** Control-plane data-dir guard. */
  commandHitsControlDir: (cwd: string, tokens: string[]) => boolean;
  /** Confine a cwd to the workspace tree. */
  resolveCwd: (cwd?: string) => string;
  /** Project's default enabled matcher set. */
  resolveMatchers: (projectId: string) => ProblemMatcherDef[];
  /** One named matcher (custom or builtin) for a project. */
  getMatcher: (projectId: string, name: string) => ProblemMatcherDef | null;
  /**
   * Parse output with matchers WITHOUT storing into the global
   * diagnostics store (job diagnostics live on the job record).
   */
  parseOutput: (defs: ProblemMatcherDef[], text: string) => { diagnostics: ProblemDiagnostic[]; stats: ParseStats };
}

let deps: TaskQueueDeps | null = null;

/** Installed once by index.ts at boot. */
export function setTaskQueueDeps(d: TaskQueueDeps | null): void {
  deps = d;
}

function needDeps(): TaskQueueDeps {
  if (!deps) throw new TaskQueueRouteError('task queue is not wired', 'not-wired', 500);
  return deps;
}

let queue = new JobQueue(DEFAULT_CONCURRENCY);
/** Chain definitions per live job (deleted when the job reaches terminal). */
const jobChains = new Map<string, TaskDef[]>();
/** Live child handles per running job (deleted when the job finishes). */
const jobChildren = new Map<string, ChildProcess>();
/** Timeout timers per running job (cleared on finish/cancel). */
const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Test seam: kill all live children and reset queue state. */
export function resetTaskQueueForTest(): void {
  for (const child of jobChildren.values()) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead — nothing to clean.
      }
    }
  }
  for (const timer of jobTimers.values()) clearTimeout(timer);
  jobChildren.clear();
  jobTimers.clear();
  jobChains.clear();
  queue = new JobQueue(DEFAULT_CONCURRENCY);
}

function resolveRoot(rawRoot?: string): string {
  const d = needDeps();
  try {
    return d.resolveRoot(rawRoot);
  } catch (e) {
    throw new TaskQueueRouteError((e as Error).message, 'bad-root', 403);
  }
}

function projectIdOf(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_\-.]{1,64}$/.test(value.trim())) {
    return value.trim();
  }
  return 'default';
}

function resolveTaskCwd(d: TaskQueueDeps, root: string, cwdOpt?: string): string {
  if (!cwdOpt) return root;
  const resolved = normalize(join(root, cwdOpt));
  if (relative(root, resolved).startsWith('..')) {
    throw new TaskQueueRouteError(`options.cwd escapes the project root: ${cwdOpt}`, 'cwd-escape', 403);
  }
  return resolved;
}

/** Build argv AFTER the policy check (same rules as the sync runner). */
function buildArgv(d: TaskQueueDeps, task: TaskDef): string[] {
  if (task.type === 'process') {
    const tokens = d.checkCommandPolicy(task.command);
    if (tokens.length !== 1) {
      throw new TaskQueueRouteError(
        `task "${task.label}": type "process" command must be a bare binary (use args for arguments)`,
        'process-args-in-command',
      );
    }
    return [tokens[0], ...task.args];
  }
  return d.checkCommandPolicy(shellCommandLine(task));
}

/** Kill a whole POSIX process group; fall back to a direct child kill. */
function killGroup(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // ESRCH (already dead) or Windows (no negative-pid kill) — fall through.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already dead.
  }
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Cancellable spawn: detached (own process group) so cancel/timeout can
 * kill the whole tree. Output is streamed into the job log (ring-capped)
 * and accumulated for matcher parsing (capped at OUTPUT_CAP_BYTES;
 * excess bytes are dropped, never stored — the process itself is NOT
 * killed for verbose output, unlike execFile's maxBuffer behavior).
 */
function spawnCancellable(
  jobId: string,
  argv: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const push = (buf: string, which: 'out' | 'err'): void => {
      queue.appendLog(jobId, buf);
      if (which === 'out') {
        stdout += buf;
        if (stdout.length > OUTPUT_CAP_BYTES) stdout = stdout.slice(0, OUTPUT_CAP_BYTES);
      } else {
        stderr += buf;
        if (stderr.length > OUTPUT_CAP_BYTES) stderr = stderr.slice(0, OUTPUT_CAP_BYTES);
      }
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...scrubCredentialEnv(process.env), ...(env ?? {}) },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    jobChildren.set(jobId, child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    jobTimers.set(jobId, timer);
    child.stdout?.on('data', (chunk: Buffer) => push(chunk.toString('utf8'), 'out'));
    child.stderr?.on('data', (chunk: Buffer) => push(chunk.toString('utf8'), 'err'));
    child.once('error', () => {
      clearTimeout(timer);
      jobTimers.delete(jobId);
      resolve({ exitCode: null, stdout, stderr, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      jobTimers.delete(jobId);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** Run one chain task inside a job; returns its recorded result. */
async function runJobTask(
  d: TaskQueueDeps,
  jobId: string,
  task: TaskDef,
  root: string,
  projectId: string,
): Promise<JobTaskResult> {
  const t0 = Date.now();
  const fail = (status: JobTaskResult['status'], error: string): JobTaskResult => ({
    label: task.label,
    status,
    exitCode: null,
    durationMs: Date.now() - t0,
    diagnosticsAdded: 0,
    error,
  });

  let cwd: string;
  try {
    cwd = resolveTaskCwd(d, root, task.options.cwd);
  } catch (e) {
    return fail('denied', (e as Error).message);
  }

  let argv: string[];
  try {
    argv = buildArgv(d, task);
  } catch (e) {
    const msg = e instanceof TaskQueueRouteError ? e.message : (e as Error).message;
    return fail('denied', msg);
  }

  if (d.commandHitsControlDir(cwd, argv)) {
    return fail('denied', 'command refused: the control-plane data directory is off-limits');
  }

  const timeoutMs = task.options.timeoutMs ?? 60_000;
  queue.setCurrentTask(jobId, task.label);
  queue.appendLog(jobId, `\n$ ${argv.join(' ')}\n`);
  let ran: SpawnOutcome;
  try {
    ran = await spawnCancellable(jobId, argv, cwd, task.options.env, timeoutMs);
  } catch (e) {
    return fail('failed', `spawn failed: ${(e as Error).message}`);
  } finally {
    jobChildren.delete(jobId);
  }
  const combined = `${ran.stdout}\n${ran.stderr}`;

  // Problem-matcher parse (job-local, never stored globally).
  const unresolved: string[] = [];
  let defs: ProblemMatcherDef[];
  if (task.problemMatcher.length > 0) {
    defs = [];
    for (const name of task.problemMatcher) {
      const m = d.getMatcher(projectId, name);
      if (m) defs.push(m);
      else unresolved.push(name);
    }
    if (defs.length === 0) defs = d.resolveMatchers(projectId);
  } else {
    defs = d.resolveMatchers(projectId);
  }
  let added = 0;
  if (defs.length > 0) {
    try {
      const { diagnostics } = d.parseOutput(defs, combined);
      added = diagnostics.length;
      queue.addDiagnostics(
        jobId,
        diagnostics.map((diag) => ({
          file: diag.file,
          line: diag.line,
          column: diag.column,
          severity: diag.severity,
          message: diag.message,
          matcher: diag.matcher,
        })),
      );
    } catch {
      // Matcher parse never fails the task itself.
    }
  }
  const notes = unresolved.length > 0 ? `unknown problemMatcher(s) skipped: ${unresolved.join(', ')}` : undefined;

  const durationMs = Date.now() - t0;
  const job = queue.get(jobId);
  if (job?.cancelRequested) {
    return { label: task.label, status: 'cancelled', exitCode: ran.exitCode, durationMs, diagnosticsAdded: added, error: 'cancelled by user' };
  }
  if (ran.timedOut) {
    const errText = `task timed out after ${timeoutMs}ms${notes ? ` (${notes})` : ''}`;
    return { label: task.label, status: 'timeout', exitCode: ran.exitCode, durationMs, diagnosticsAdded: added, error: errText };
  }
  if (ran.exitCode !== 0) {
    const errText = `task exited with code ${ran.exitCode}${notes ? ` (${notes})` : ''}`;
    return { label: task.label, status: 'failed', exitCode: ran.exitCode, durationMs, diagnosticsAdded: added, error: errText };
  }
  return { label: task.label, status: 'ok', exitCode: 0, durationMs, diagnosticsAdded: added, ...(notes ? { error: notes } : {}) };
}

/** Drive one job to terminal state, then pump the next queued job. */
async function executeJob(jobId: string, ctx: RouteContext, actor: string): Promise<void> {
  const d = needDeps();
  const job = queue.get(jobId);
  if (!job) return;
  const chain = jobChains.get(jobId) ?? [];
  let outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
  let lastExit: number | null = 0;
  try {
    for (const task of chain) {
      const current = queue.get(jobId);
      if (!current || current.cancelRequested) {
        outcome = 'cancelled';
        break;
      }
      const result = await runJobTask(d, jobId, task, job.root, job.projectId);
      queue.recordTask(jobId, result);
      lastExit = result.exitCode;
      if (result.status === 'cancelled') {
        outcome = 'cancelled';
        break;
      }
      if (result.status !== 'ok') {
        outcome = 'failed';
        break;
      }
    }
    const final = queue.get(jobId);
    if (final?.cancelRequested && outcome !== 'cancelled') outcome = 'cancelled';
  } catch (e) {
    outcome = 'failed';
    queue.markFinished(jobId, 'failed', null, `job runner error: ${(e as Error).message}`);
    jobChains.delete(jobId);
    ctx.audit.record(actor, 'TASKQUEUE_FAILED', 'taskqueue', jobId, { error: (e as Error).message });
    pump(ctx, actor);
    return;
  }
  const finished = queue.markFinished(
    jobId,
    outcome,
    outcome === 'succeeded' ? 0 : lastExit,
    outcome === 'cancelled' ? 'cancelled by user' : outcome === 'failed' ? 'chain stopped at a failed task' : undefined,
  );
  jobChains.delete(jobId);
  if (finished) {
    ctx.audit.record(actor, outcome === 'succeeded' ? 'TASKQUEUE_SUCCEEDED' : outcome === 'cancelled' ? 'TASKQUEUE_CANCELLED' : 'TASKQUEUE_FAILED', 'taskqueue', jobId, {
      label: job.label,
      tasks: finished.completedTaskCount,
    });
  }
  pump(ctx, actor);
}

/** Start queued jobs while slots are free (synchronous admission). */
function pump(ctx: RouteContext, actor: string): void {
  while (queue.hasFreeSlot()) {
    const next = queue.peekNext();
    if (!next) return;
    if (!queue.markRunning(next.id)) return;
    void executeJob(next.id, ctx, actor).catch(() => {
      // executeJob handles its own errors; this is a last-resort guard
      // so a bug never leaves a job stuck 'running' without pumping.
      if (queue.get(next.id)?.status === 'running') {
        queue.markFinished(next.id, 'failed', null, 'job runner crashed');
        jobChains.delete(next.id);
      }
      pump(ctx, actor);
    });
  }
}

function jobDetail(id: string): { job: JobSummary; tasks: JobTaskResult[]; diagnostics: JobDiagnostic[] } | null {
  const job = queue.get(id);
  if (!job) return null;
  return {
    job: JobQueue.toSummary(job),
    tasks: [...job.tasks],
    diagnostics: [...job.diagnostics],
  };
}

export async function handleTaskQueueRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const rawPath = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  if (!rawPath.startsWith(PREFIX)) return false;

  try {
    // ---- submit -------------------------------------------------------
    if (rawPath === `${PREFIX}/submit` && method === 'POST') {
      const d = needDeps();
      const body = await ctx.readBody(req);
      const label = body['label'];
      if (typeof label !== 'string' || label.length === 0) {
        ctx.json(res, 400, { error: 'label is required', code: 'bad-label' });
        return true;
      }
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const projectId = projectIdOf(body['projectId']);
      const actor = (body['actor'] as string | undefined) ?? 'human';

      let text: string;
      try {
        text = readFileSync(join(root, TASKS_FILE), 'utf8');
      } catch {
        ctx.json(res, 404, { error: 'no tasks file for this project', code: 'no-tasks-file' });
        return true;
      }
      if (text.length > MAX_FILE_BYTES) {
        ctx.json(res, 400, { error: `tasks file exceeds ${MAX_FILE_BYTES} bytes`, code: 'file-too-big' });
        return true;
      }
      const parsed = parseTasksJson(text);
      if (parsed.errors.length > 0) {
        ctx.json(res, 400, { error: 'tasks file has validation errors', errors: parsed.errors, code: 'invalid-tasks' });
        return true;
      }
      const planned = planRun(parsed.tasks, [label]);
      if (planned.errors.length > 0) {
        ctx.json(res, 400, { error: 'cannot plan task run', errors: planned.errors, code: 'plan-failed' });
        return true;
      }
      const flat = flattenPlan(planned.plan);
      const job = queue.submit(label, flat.map((t) => t.label), root, projectId);
      jobChains.set(job.id, flat);
      ctx.audit.record(actor, 'TASKQUEUE_SUBMITTED', 'taskqueue', job.id, { label, chain: job.chain });
      pump(ctx, actor);
      ctx.json(res, 201, { job: JobQueue.toSummary(queue.get(job.id)!) });
      return true;
    }

    // ---- list ---------------------------------------------------------
    if (rawPath === `${PREFIX}/jobs` && method === 'GET') {
      ctx.json(res, 200, {
        jobs: queue.summaries(),
        config: queue.getConfig(),
        running: queue.runningCount(),
        queued: queue.queuedCount(),
      });
      return true;
    }

    // ---- config -------------------------------------------------------
    if (rawPath === `${PREFIX}/config` && method === 'GET') {
      ctx.json(res, 200, { ...queue.getConfig(), running: queue.runningCount(), queued: queue.queuedCount() });
      return true;
    }
    if (rawPath === `${PREFIX}/config` && method === 'PUT') {
      const body = await ctx.readBody(req);
      const result = queue.setMaxConcurrency(body['maxConcurrency']);
      if (!result.ok) {
        ctx.json(res, 400, { error: result.error, code: 'bad-concurrency' });
        return true;
      }
      pump(ctx, 'human');
      ctx.json(res, 200, { ...queue.getConfig(), running: queue.runningCount(), queued: queue.queuedCount() });
      return true;
    }

    // ---- job detail / log / cancel ------------------------------------
    const jobMatch = rawPath.match(/^\/api\/taskqueue\/jobs\/([^/]+)(\/(log|cancel))?$/);
    if (jobMatch) {
      const id = decodeURIComponent(jobMatch[1]);
      const suffix = jobMatch[3];
      if (suffix === 'log' && method === 'GET') {
        const job = queue.get(id);
        if (!job) {
          ctx.json(res, 404, { error: 'unknown job', code: 'unknown-job' });
          return true;
        }
        ctx.json(res, 200, { jobId: id, log: job.log, truncated: job.logTruncated, byteLength: Buffer.byteLength(job.log, 'utf8') });
        return true;
      }
      if (suffix === 'cancel' && method === 'POST') {
        const body = await ctx.readBody(req);
        const actor = (body['actor'] as string | undefined) ?? 'human';
        const result = queue.cancel(id);
        if (result === 'unknown') {
          ctx.json(res, 404, { error: 'unknown job', code: 'unknown-job' });
          return true;
        }
        if (result === 'cancelled') {
          jobChains.delete(id);
          ctx.audit.record(actor, 'TASKQUEUE_CANCELLED', 'taskqueue', id, { beforeStart: true });
          pump(ctx, actor);
        } else if (result === 'cancel-requested') {
          const child = jobChildren.get(id);
          if (child) killGroup(child);
          const timer = jobTimers.get(id);
          if (timer) clearTimeout(timer);
          ctx.audit.record(actor, 'TASKQUEUE_CANCEL_REQUESTED', 'taskqueue', id, {});
        }
        const detail = jobDetail(id);
        ctx.json(res, 200, { job: detail!.job, result });
        return true;
      }
      if (!suffix && method === 'GET') {
        const detail = jobDetail(id);
        if (!detail) {
          ctx.json(res, 404, { error: 'unknown job', code: 'unknown-job' });
          return true;
        }
        ctx.json(res, 200, detail);
        return true;
      }
    }
  } catch (e) {
    if (e instanceof TaskQueueRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return false;
}
