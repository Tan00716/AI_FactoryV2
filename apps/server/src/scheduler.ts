/**
 * General task scheduler (local cron) — server-side only.
 *
 * Codex has scheduled tasks; AI Factory had only backup schedules
 * (§47, Batch 20 — admin-gated, backup-only, SQLite rows). This is the
 * general-purpose equivalent: operator-configured schedules that fire
 * typed jobs on a cron expression or a fixed interval.
 *
 * Job types (v1):
 *   - run-task : create a task from an operator template and start an
 *                agent run for it (same machinery as POST /api/runtime/runs)
 *   - webhook  : call an external URL; the response body is UNTRUSTED —
 *                it is quarantined through sanitizeUntrusted() before it
 *                is stored, audited, or substituted into a task goal
 *                (W-B lesson: external content is DATA, never directives)
 *   - backup   : run the same createBackup() the manual endpoint uses
 *
 * Design notes (mirroring the backup scheduler's safety posture):
 *  - The scheduler is deliberately boring: a process-internal 30s tick
 *    asks each active schedule "are you due?" — no worker threads, no
 *    backfill. Missed slots are NEVER replayed: boot() advances past-due
 *    schedules to their next future slot and audits SCHEDULE_MISSED.
 *  - A failed firing does not retry by itself: it is recorded 'failed'
 *    (audit SCHEDULE_FAILED), the next slot is still advanced.
 *  - The tick never overlaps itself (single-threaded, runs to completion).
 *  - Persistence is a JSON file with atomic temp+rename writes, corrupt
 *    fail-closed (serves empty, refuses writes) — the session-store
 *    pattern. Every mutation persists immediately, so shutdown()
 *    persisting again is belt-and-braces.
 *  - Cron is a self-contained 5-field parser (minute hour day-of-month
 *    month day-of-week), UTC, minute precision — same semantics as the
 *    backup scheduler's parser, no external dependency.
 *
 * This module is pure: it imports only node builtins and
 * @ai-factory/security. Job execution side-effects are injected via
 * SchedulerDeps so tests can run it with a fake clock and fake
 * executors (node --test imports this file straight from src).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeUntrusted } from '@ai-factory/security';

// ------------------------------------------------------------------ cron --

/** Field ranges: minute, hour, day-of-month, month, day-of-week. */
const CRON_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

function parseCronField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  const add = (n: number): void => {
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new Error(`cron value ${n} out of range [${lo}, ${hi}]`);
    }
    out.add(n);
  };
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let n = lo; n <= hi; n++) out.add(n);
      continue;
    }
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`invalid cron step: ${part}`);
      }
      for (let n = lo; n <= hi; n += step) out.add(n);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (a > b) throw new Error(`invalid cron range: ${part}`);
      for (let n = a; n <= b; n++) add(n);
      continue;
    }
    if (/^\d+$/.test(part)) {
      // Cron convention: 7 is also Sunday.
      const n = Number(part) === 7 && hi === 6 ? 0 : Number(part);
      add(n);
      continue;
    }
    throw new Error(`invalid cron field part: ${part}`);
  }
  if (out.size === 0) throw new Error('cron field matched nothing');
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

/** Parse a 5-field cron expression; throws ScheduleError on invalid input. */
export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError(
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => {
    const [lo, hi] = CRON_RANGES[i]!;
    try {
      return parseCronField(f, lo, hi);
    } catch (e) {
      throw new ScheduleError(
        `cron field '${CRON_FIELD_NAMES[i]}' (${f}): ${(e as Error).message}`,
      );
    }
  });
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow! };
}

function cronMatches(c: ParsedCron, d: Date): boolean {
  return (
    c.minute.has(d.getUTCMinutes()) &&
    c.hour.has(d.getUTCHours()) &&
    c.dom.has(d.getUTCDate()) &&
    c.month.has(d.getUTCMonth() + 1) &&
    c.dow.has(d.getUTCDay())
  );
}

/**
 * Next cron occurrence strictly after `after`, in UTC. Steps minute by
 * minute, capped at 366 days — a schedule that cannot occur within a
 * year (e.g. Feb 30) is a configuration error, reported as such.
 */
export function nextCronTime(expr: string, after: Date): Date {
  const c = parseCronExpr(expr);
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, d)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new ScheduleError(`cron expression never matches within a year: ${expr}`);
}

// ----------------------------------------------------------------- types --

export const MIN_INTERVAL_MS = 60_000;
export const SCHEDULER_TICK_MS = 30_000;
/** Webhook bodies larger than this are truncated before sanitize+store. */
export const WEBHOOK_BODY_LIMIT = 64 * 1024;

export type ScheduleKind = 'cron' | 'interval';
export type ScheduleStatus = 'active' | 'paused';

export interface RunTaskJob {
  type: 'run-task';
  /** Operator-configured task template (trusted: operator role). */
  title: string;
  goal?: string;
  projectId?: string | null;
  /** When set, a run is started for the created task. */
  agentId?: string | null;
}

export interface WebhookJob {
  type: 'webhook';
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /**
   * Optional follow-up: after fetching, create a task whose goal is
   * goalTemplate with {{output}} replaced by the SANITIZED response
   * body, and optionally start a run for it. This is the one path
   * where untrusted external content can reach a model prompt — the
   * substitution value is always sanitizeUntrusted(body).sanitized,
   * never the raw bytes.
   */
  forwardToTask?: {
    title: string;
    goalTemplate: string;
    agentId?: string | null;
  } | null;
}

export interface BackupJob {
  type: 'backup';
}

export type ScheduleJob = RunTaskJob | WebhookJob | BackupJob;

export interface Schedule {
  id: string;
  name: string;
  kind: ScheduleKind;
  cronExpr: string | null;
  intervalMs: number | null;
  job: ScheduleJob;
  status: ScheduleStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  /** Sanitized snippet of the last webhook body (null for other jobs). */
  lastOutput: string | null;
  runCount: number;
}

export interface CreateScheduleInput {
  name: string;
  kind: ScheduleKind;
  cronExpr?: string;
  intervalMs?: number;
  job: ScheduleJob;
  createdBy?: string;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export function scheduleStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_SCHEDULE_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'schedules.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Atomic write: temp file then rename (crash-safe). */
function atomicWriteJson(path: string, payload: unknown): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

function isValidJob(job: unknown): job is ScheduleJob {
  if (!job || typeof job !== 'object') return false;
  const j = job as Record<string, unknown>;
  if (j['type'] === 'run-task') {
    return typeof j['title'] === 'string' && j['title'].trim().length > 0;
  }
  if (j['type'] === 'webhook') {
    return typeof j['url'] === 'string' && j['url'].trim().length > 0;
  }
  if (j['type'] === 'backup') return true;
  return false;
}

function isValidSchedule(s: unknown): s is Schedule {
  if (!s || typeof s !== 'object') return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    (r['kind'] === 'cron' || r['kind'] === 'interval') &&
    (r['status'] === 'active' || r['status'] === 'paused') &&
    isValidJob(r['job']) &&
    typeof r['runCount'] === 'number'
  );
}

/** Next slot for a schedule, strictly after `from`. */
export function computeNextRun(
  s: Pick<Schedule, 'kind' | 'cronExpr' | 'intervalMs'>,
  from: Date,
): Date {
  if (s.kind === 'interval') {
    if (!s.intervalMs || s.intervalMs < MIN_INTERVAL_MS) {
      throw new ScheduleError(`interval must be >= ${MIN_INTERVAL_MS} ms`);
    }
    return new Date(from.getTime() + s.intervalMs);
  }
  if (!s.cronExpr) throw new ScheduleError('cron schedule requires cronExpr');
  return nextCronTime(s.cronExpr, from);
}

function validateJob(job: ScheduleJob): void {
  if (job.type === 'run-task') {
    if (!job.title.trim()) throw new ScheduleError('run-task job requires a title');
    if (job.title.length > 200) throw new ScheduleError('run-task title too long (max 200)');
    if (job.goal !== undefined && job.goal.length > 8000) {
      throw new ScheduleError('run-task goal too long (max 8000)');
    }
  } else if (job.type === 'webhook') {
    let u: URL;
    try {
      u = new URL(job.url);
    } catch {
      throw new ScheduleError(`webhook url is not a valid URL: ${job.url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new ScheduleError('webhook url must be http(s)');
    }
    // Webhook targets are operator-trusted by design (only operators
    // can create schedules); the URL is still validated as http(s).
    if (job.method !== undefined && job.method !== 'GET' && job.method !== 'POST') {
      throw new ScheduleError('webhook method must be GET or POST');
    }
    const fwd = job.forwardToTask;
    if (fwd !== undefined && fwd !== null) {
      if (!fwd.title.trim()) throw new ScheduleError('forwardToTask requires a title');
      if (!fwd.goalTemplate.includes('{{output}}')) {
        throw new ScheduleError('forwardToTask goalTemplate must contain {{output}}');
      }
    }
  }
  // 'backup' needs no parameters.
}

// ----------------------------------------------------------------- store --

export class ScheduleStore {
  private readonly path: string;
  private schedules: Map<string, Schedule> | null = null;
  private corrupt = false;

  constructor(path: string = scheduleStorePath()) {
    this.path = path;
  }

  isCorrupt(): boolean {
    this.load();
    return this.corrupt;
  }

  private load(): Map<string, Schedule> {
    if (this.schedules) return this.schedules;
    const map = new Map<string, Schedule>();
    if (!existsSync(this.path)) {
      this.schedules = map;
      return map;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { schedules?: unknown[] };
      for (const s of raw.schedules ?? []) {
        if (isValidSchedule(s)) map.set(s.id, s);
      }
    } catch {
      // Fail-closed: serve empty, refuse writes — never silently drop schedules.
      this.corrupt = true;
      this.schedules = new Map();
      return this.schedules;
    }
    this.schedules = map;
    return map;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new ScheduleError('schedule store is corrupt; refusing writes');
    }
    atomicWriteJson(this.path, { schedules: [...this.load().values()] });
  }

  /** Explicit flush (used by graceful shutdown); mutations persist already. */
  flush(): void {
    this.persist();
  }

  list(): Schedule[] {
    return [...this.load().values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): Schedule | undefined {
    return this.load().get(id);
  }

  create(input: CreateScheduleInput): Schedule {
    const name = input.name.trim();
    if (!name) throw new ScheduleError('name is required');
    if (name.length > 120) throw new ScheduleError('name too long (max 120)');
    validateJob(input.job);
    let cronExpr: string | null = null;
    let intervalMs: number | null = null;
    if (input.kind === 'cron') {
      if (!input.cronExpr) throw new ScheduleError('cron schedule requires cronExpr');
      parseCronExpr(input.cronExpr); // validates; throws ScheduleError
      cronExpr = input.cronExpr.trim();
    } else if (input.kind === 'interval') {
      if (!input.intervalMs || input.intervalMs < MIN_INTERVAL_MS) {
        throw new ScheduleError(`interval must be >= ${MIN_INTERVAL_MS} ms`);
      }
      intervalMs = Math.floor(input.intervalMs);
    } else {
      throw new ScheduleError(`unknown schedule kind: ${String(input.kind)}`);
    }
    const now = new Date();
    const s: Schedule = {
      id: randomUUID(),
      name,
      kind: input.kind,
      cronExpr,
      intervalMs,
      job: input.job,
      status: 'active',
      createdBy: input.createdBy ?? 'human',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      nextRunAt: computeNextRun({ kind: input.kind, cronExpr, intervalMs }, now).toISOString(),
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastOutput: null,
      runCount: 0,
    };
    this.load().set(s.id, s);
    this.persist();
    return s;
  }

  update(id: string, patch: { name?: string; status?: ScheduleStatus }): Schedule {
    const s = this.load().get(id);
    if (!s) throw new ScheduleError(`schedule not found: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ScheduleError('name is required');
      if (name.length > 120) throw new ScheduleError('name too long (max 120)');
      s.name = name;
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'paused') {
        throw new ScheduleError(`invalid status: ${patch.status}`);
      }
      s.status = patch.status;
    }
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  remove(id: string): void {
    if (!this.load().delete(id)) throw new ScheduleError(`schedule not found: ${id}`);
    this.persist();
  }

  /** Record a firing outcome and advance to the next slot. */
  recordRun(
    id: string,
    result: { ok: boolean; error?: string | null; output?: string | null },
    at: Date,
  ): Schedule {
    const s = this.load().get(id);
    if (!s) throw new ScheduleError(`schedule not found: ${id}`);
    s.lastRunAt = at.toISOString();
    s.lastStatus = result.ok ? 'ok' : 'failed';
    s.lastError = result.ok ? null : (result.error ?? 'unknown error').slice(0, 500);
    if (result.output !== undefined) s.lastOutput = result.output;
    s.runCount += 1;
    s.nextRunAt = computeNextRun(s, at).toISOString();
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  /** Boot reconcile: advance a past-due slot without firing (no backfill). */
  advanceMissed(id: string, at: Date): Schedule {
    const s = this.load().get(id);
    if (!s) throw new ScheduleError(`schedule not found: ${id}`);
    s.nextRunAt = computeNextRun(s, at).toISOString();
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }
}

// ------------------------------------------------------------- scheduler --

export interface JobResult {
  ok: boolean;
  summary: string;
  taskId?: string;
  runId?: string;
  backupId?: string;
  webhookStatus?: number;
  /** Sanitized webhook body (webhook jobs only) — quarantined form. */
  output?: string;
}

export interface WebhookFetchOpts {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface SchedulerDeps {
  store: ScheduleStore;
  audit: {
    record(
      actor: string,
      event: string,
      entityType: string,
      entityId: string,
      details?: Record<string, unknown>,
    ): void;
  };
  createTask(input: { title: string; goal?: string; projectId?: string | null }): { id: string };
  startRun(input: { agentId: string; taskId: string }): Promise<{ runId: string }>;
  runBackup(): { backupId: string };
  fetchWebhook(url: string, opts: WebhookFetchOpts): Promise<{ status: number; body: string }>;
  now?: () => Date;
}

export class TaskScheduler {
  private readonly deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Boot reconcile: any active schedule whose nextRunAt already passed
   * is advanced to its next FUTURE slot and audited SCHEDULE_MISSED.
   * Missed executions are never backfilled.
   */
  boot(): void {
    const now = this.now();
    for (const s of this.deps.store.list()) {
      if (s.status !== 'active' || !s.nextRunAt) continue;
      if (new Date(s.nextRunAt).getTime() <= now.getTime()) {
        this.deps.store.advanceMissed(s.id, now);
        this.deps.audit.record('system', 'SCHEDULE_MISSED', 'schedule', s.id, {
          name: s.name,
          missedSlot: s.nextRunAt,
        });
      }
    }
  }

  /** Fire every active schedule whose slot is due. Never throws. */
  async tick(now?: Date): Promise<void> {
    const at = now ?? this.now();
    for (const s of this.deps.store.list()) {
      if (s.status !== 'active' || !s.nextRunAt) continue;
      if (new Date(s.nextRunAt).getTime() > at.getTime()) continue;
      try {
        await this.fireSchedule(s, 'tick', at);
      } catch (e) {
        // fireSchedule records failures itself; this is belt-and-braces
        // so one bad schedule can never break the tick for the rest.
        this.deps.audit.record('system', 'SCHEDULE_TICK_ERROR', 'schedule', s.id, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /** Manual trigger (operator). Fires regardless of the slot clock. */
  async trigger(id: string): Promise<JobResult> {
    const s = this.deps.store.get(id);
    if (!s) throw new ScheduleError(`schedule not found: ${id}`);
    return this.fireSchedule(s, 'manual', this.now());
  }

  /** Graceful shutdown: final persist (mutations persist already). */
  shutdown(): void {
    try {
      this.deps.store.flush();
    } catch {
      // Best effort only — the process is going down.
    }
  }

  private async fireSchedule(s: Schedule, trigger: 'tick' | 'manual', at: Date): Promise<JobResult> {
    let result: JobResult;
    try {
      result = await this.executeJob(s);
    } catch (e) {
      result = { ok: false, summary: `job failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const recordOutput = result.ok && s.job.type === 'webhook' ? result.output ?? null : undefined;
    this.deps.store.recordRun(
      s.id,
      {
        ok: result.ok,
        error: result.ok ? null : result.summary,
        output: recordOutput,
      },
      at,
    );
    this.deps.audit.record('system', 'SCHEDULE_FIRED', 'schedule', s.id, {
      name: s.name,
      trigger,
      jobType: s.job.type,
      ok: result.ok,
      summary: result.summary.slice(0, 500),
      ...(result.taskId ? { taskId: result.taskId } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.backupId ? { backupId: result.backupId } : {}),
    });
    if (!result.ok) {
      this.deps.audit.record('system', 'SCHEDULE_FAILED', 'schedule', s.id, {
        name: s.name,
        trigger,
        error: result.summary.slice(0, 500),
      });
    }
    return result;
  }

  private async executeJob(s: Schedule): Promise<JobResult> {
    const job = s.job;
    if (job.type === 'run-task') {
      const task = this.deps.createTask({
        title: job.title,
        goal: job.goal,
        projectId: job.projectId ?? null,
      });
      if (job.agentId) {
        const { runId } = await this.deps.startRun({ agentId: job.agentId, taskId: task.id });
        return { ok: true, summary: `task ${task.id} created, run ${runId} started`, taskId: task.id, runId };
      }
      return { ok: true, summary: `task ${task.id} created (no agent — run not started)`, taskId: task.id };
    }
    if (job.type === 'webhook') {
      const res = await this.deps.fetchWebhook(job.url, {
        method: job.method ?? 'GET',
        headers: job.headers ?? {},
        body: job.body,
        timeoutMs: job.timeoutMs ?? 15_000,
      });
      // Injection boundary: the response body is untrusted external
      // content — quarantine it through sanitizeUntrusted() before it
      // is stored, audited, or substituted into a task goal. Raw bytes
      // never reach a prompt.
      const raw = res.body.length > WEBHOOK_BODY_LIMIT ? res.body.slice(0, WEBHOOK_BODY_LIMIT) : res.body;
      const sanitized = sanitizeUntrusted(raw).sanitized;
      let taskId: string | undefined;
      let runId: string | undefined;
      const fwd = job.forwardToTask;
      if (fwd) {
        const goal = fwd.goalTemplate.split('{{output}}').join(sanitized);
        const task = this.deps.createTask({ title: fwd.title, goal });
        taskId = task.id;
        if (fwd.agentId) {
          runId = (await this.deps.startRun({ agentId: fwd.agentId, taskId: task.id })).runId;
        }
      }
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          summary: `webhook ${job.url} -> HTTP ${res.status} (body sanitized, ${sanitized.length} chars)`,
          webhookStatus: res.status,
          output: sanitized,
          taskId,
          runId,
        };
      }
      return {
        ok: true,
        summary: `webhook ${job.url} -> HTTP ${res.status} (body sanitized, ${sanitized.length} chars)`,
        webhookStatus: res.status,
        output: sanitized,
        taskId,
        runId,
      };
    }
    // backup
    const { backupId } = this.deps.runBackup();
    return { ok: true, summary: `backup ${backupId} created`, backupId };
  }
}
