/**
 * Backup schedules + in-process scheduler — Batch 20 (§47).
 *
 *   GET    /api/backup/schedules            list schedules
 *   POST   /api/backup/schedules            create a schedule
 *   GET    /api/backup/schedules/:id        one schedule
 *   PATCH  /api/backup/schedules/:id        update (name/enabled/spec)
 *   DELETE /api/backup/schedules/:id        delete
 *   POST   /api/backup/schedules/:id/run    run now (manual trigger)
 *
 * A schedule is either kind 'interval' (every interval_ms, floor 60s)
 * or kind 'cron' (a 5-field cron expression evaluated in UTC, minute
 * precision). The scheduler itself is deliberately boring on purpose:
 * a process-internal tick (30s in the server wiring) that asks each
 * enabled schedule "are you due?" and runs the SAME createBackup()
 * the manual endpoint uses — the backup path is not duplicated.
 *
 * Safety posture, stated plainly:
 *  - Schedules are durable rows (backup_schedules): a restart loses
 *    nothing. At boot the scheduler reconciles: any enabled schedule
 *    whose next_run_at already passed is marked MISSED (audit
 *    BACKUP_SCHEDULE_MISSED, actor 'system') and advanced to its next
 *    FUTURE slot. Missed executions are NEVER backfilled — replaying
 *    a missed backup could collide with a busy window, and a surprise
 *    backup storm after a long outage is worse than a recorded miss.
 *  - A failed scheduled run does not retry by itself: it is recorded
 *    'failed' (audit BACKUP_SCHEDULE_FAILED), the next slot is still
 *    advanced, and the operator sees it in the schedule row.
 *  - The tick never overlaps itself: Node is single-threaded and a
 *    tick runs to completion before the next one starts.
 *  - RBAC (auth.ts): reads viewer, everything else admin — schedules
 *    create backups, which are admin in this codebase.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  type BackupSchedule,
  type BackupScheduleKind,
  type BackupScheduleStatus,
  type SqliteBackupScheduleStore,
} from '@ai-factory/db';
import { createBackup, type BackupManifest } from './backup';
import type { RouteContext } from './context';

export const MIN_INTERVAL_MS = 60_000;
export const TICK_MS = 30_000;

// ------------------------------------------------------------------ cron --

/** Field ranges: minute, hour, day-of-month, month, day-of-week. */
const CRON_RANGES: [number, number][] = [
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
      add(a);
      for (let n = a + 1; n <= b; n++) add(n);
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

export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => {
    const [lo, hi] = CRON_RANGES[i]!;
    try {
      return parseCronField(f, lo, hi);
    } catch (e) {
      throw new Error(
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
 * Next cron occurrence strictly after `after`, in UTC. Steps minute
 * by minute, capped at 366 days — a schedule that cannot occur within
 * a year (e.g. Feb 30) is a configuration error, reported as such.
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
  throw new Error(`cron expression never matches within a year: ${expr}`);
}

/** Next slot for a schedule spec, strictly after `from`. */
export function computeNextRun(
  schedule: Pick<BackupSchedule, 'scheduleKind' | 'intervalMs' | 'cronExpr'>,
  from: Date,
): Date {
  if (schedule.scheduleKind === 'interval') {
    if (!schedule.intervalMs || schedule.intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`interval must be >= ${MIN_INTERVAL_MS} ms`);
    }
    return new Date(from.getTime() + schedule.intervalMs);
  }
  if (!schedule.cronExpr) throw new Error('cron schedule requires cronExpr');
  return nextCronTime(schedule.cronExpr, from);
}

// --------------------------------------------------------------- scheduler --

export interface SchedulerDeps {
  schedules: SqliteBackupScheduleStore;
  audit: {
    record(
      actor: string,
      event: string,
      entityType: string,
      entityId: string,
      details?: Record<string, unknown>,
    ): void;
  };
  /** The one backup path — the scheduler never invents its own. */
  runBackup: () => { backupId: string; dir: string; manifest: BackupManifest };
  now?: () => Date;
}

export class BackupScheduler {
  private deps: SchedulerDeps;
  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Boot reconcile: enabled schedules whose next_run_at already
   * passed while this process was down are marked MISSED (audited,
   * actor 'system') and advanced to their next future slot. Nothing
   * is backfilled — the miss is the honest record.
   */
  boot(overrideNow?: Date): { missed: string[] } {
    const now = overrideNow ?? this.now();
    const missed: string[] = [];
    for (const s of this.deps.schedules.list()) {
      if (!s.enabled) continue;
      if (Date.parse(s.nextRunAt) > now.getTime()) continue;
      const next = this.advanceToFuture(s, now);
      this.deps.schedules.recordRun(s.id, 'MISSED', now.toISOString(), next.toISOString());
      this.deps.audit.record('system', 'BACKUP_SCHEDULE_MISSED', 'backup_schedule', s.id, {
        name: s.name,
        missedAt: now.toISOString(),
        nextRunAt: next.toISOString(),
      });
      missed.push(s.id);
    }
    return { missed };
  }

  /** One tick: run every enabled schedule that is due. */
  tick(overrideNow?: Date): { ran: string[]; failed: string[] } {
    const now = overrideNow ?? this.now();
    const ran: string[] = [];
    const failed: string[] = [];
    for (const s of this.deps.schedules.list()) {
      if (!s.enabled) continue;
      if (Date.parse(s.nextRunAt) > now.getTime()) continue;
      try {
        const { backupId } = this.deps.runBackup();
        const next = this.advance(s, now);
        this.deps.schedules.recordRun(s.id, 'ok', now.toISOString(), next.toISOString());
        this.deps.audit.record('system', 'BACKUP_SCHEDULED', 'backup_schedule', s.id, {
          name: s.name,
          backupId,
          nextRunAt: next.toISOString(),
        });
        ran.push(s.id);
      } catch (e) {
        const next = this.advance(s, now);
        this.deps.schedules.recordRun(s.id, 'failed', now.toISOString(), next.toISOString());
        this.deps.audit.record('system', 'BACKUP_SCHEDULE_FAILED', 'backup_schedule', s.id, {
          name: s.name,
          error: (e as Error).message,
          nextRunAt: next.toISOString(),
        });
        failed.push(s.id);
      }
    }
    return { ran, failed };
  }

  private advance(s: BackupSchedule, from: Date): Date {
    return computeNextRun(s, from);
  }

  /** Advance repeatedly until the slot is in the future (post-outage). */
  private advanceToFuture(s: BackupSchedule, now: Date): Date {
    let next = this.advance(s, now);
    // Interval schedules anchored on a stale next_run_at: walk the
    // grid forward so the cadence stays anchored instead of drifting.
    if (s.scheduleKind === 'interval' && s.intervalMs) {
      let base = Date.parse(s.nextRunAt);
      while (base <= now.getTime()) base += s.intervalMs;
      next = new Date(base);
    }
    return next;
  }
}

// ------------------------------------------------------------ coordinator --

let scheduler: BackupScheduler | null = null;

export function initBackupScheduler(deps: SchedulerDeps): BackupScheduler {
  scheduler = new BackupScheduler(deps);
  return scheduler;
}

export function backupScheduler(): BackupScheduler {
  if (!scheduler) throw new Error('backup scheduler not initialized');
  return scheduler;
}

// ------------------------------------------------------------------ routes --

const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidScheduleId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    SCHEDULE_ID_RE.test(id) &&
    !id.includes('..')
  );
}

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.length > 0 ? a : 'human';
}

interface ScheduleInput {
  name: unknown;
  kind: unknown;
  intervalMs: unknown;
  cronExpr: unknown;
  enabled: unknown;
}

function validateSpec(
  kind: unknown,
  intervalMs: unknown,
  cronExpr: unknown,
): { scheduleKind: BackupScheduleKind; intervalMs: number | null; cronExpr: string | null } {
  if (kind !== 'interval' && kind !== 'cron') {
    throw new Error("kind must be 'interval' or 'cron'");
  }
  if (kind === 'interval') {
    if (cronExpr !== undefined && cronExpr !== null) {
      throw new Error('cronExpr is not valid for kind interval');
    }
    if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs)) {
      throw new Error('intervalMs must be an integer number of milliseconds');
    }
    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`intervalMs must be >= ${MIN_INTERVAL_MS} (60s floor)`);
    }
    return { scheduleKind: 'interval', intervalMs, cronExpr: null };
  }
  if (intervalMs !== undefined && intervalMs !== null) {
    throw new Error('intervalMs is not valid for kind cron');
  }
  if (typeof cronExpr !== 'string' || cronExpr.trim().length === 0) {
    throw new Error('cronExpr is required for kind cron');
  }
  parseCronExpr(cronExpr); // throws with a readable message
  return { scheduleKind: 'cron', intervalMs: null, cronExpr: cronExpr.trim() };
}

export async function handleBackupScheduleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const { json, readBody, audit, fdb } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (!p.startsWith('/api/backup/schedules')) return false;
  const store = fdb.backupSchedules;

  if (p === '/api/backup/schedules' && method === 'GET') {
    json(res, 200, { schedules: store.list() });
    return true;
  }

  if (p === '/api/backup/schedules' && method === 'POST') {
    const b = await readBody(req);
    const input = b as unknown as ScheduleInput;
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      json(res, 400, { error: 'name is required' });
      return true;
    }
    let spec;
    try {
      spec = validateSpec(input.kind, input.intervalMs, input.cronExpr);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
      return true;
    }
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    const now = new Date();
    const next = computeNextRun(
      { scheduleKind: spec.scheduleKind, intervalMs: spec.intervalMs, cronExpr: spec.cronExpr },
      now,
    );
    const actor = actorOf(b);
    const schedule = store.create(
      { name: input.name.trim(), ...spec, enabled },
      next.toISOString(),
      actor,
      now.toISOString(),
    );
    audit.record(actor, 'BACKUP_SCHEDULE_CREATED', 'backup_schedule', schedule.id, {
      name: schedule.name,
      scheduleKind: schedule.scheduleKind,
      intervalMs: schedule.intervalMs,
      cronExpr: schedule.cronExpr,
      nextRunAt: schedule.nextRunAt,
    });
    json(res, 201, { schedule });
    return true;
  }

  const idMatch = p.match(/^\/api\/backup\/schedules\/([^/]+)(\/run)?$/);
  if (!idMatch) return false;
  const id = decodeURIComponent(idMatch[1]!);
  if (!isValidScheduleId(id)) {
    json(res, 400, { error: 'invalid schedule id' });
    return true;
  }

  if (idMatch[2] === '/run' && method === 'POST') {
    const existing = store.get(id);
    if (!existing) {
      json(res, 404, { error: `unknown backup schedule: ${id}` });
      return true;
    }
    const b = await readBody(req);
    const actor = actorOf(b);
    const now = new Date();
    try {
      const { backupId, manifest } = createBackup(fdb, 'scheduled');
      const next = computeNextRun(existing, now);
      store.recordRun(id, 'ok', now.toISOString(), next.toISOString());
      audit.record(actor, 'BACKUP_SCHEDULED', 'backup_schedule', id, {
        name: existing.name,
        backupId,
        kind: manifest.kind,
        manual: true,
        nextRunAt: next.toISOString(),
      });
      json(res, 200, { ok: true, backupId, manual: true });
      return true;
    } catch (e) {
      const next = computeNextRun(existing, now);
      store.recordRun(id, 'failed', now.toISOString(), next.toISOString());
      audit.record(actor, 'BACKUP_SCHEDULE_FAILED', 'backup_schedule', id, {
        name: existing.name,
        error: (e as Error).message,
        manual: true,
      });
      json(res, 500, { error: `scheduled backup failed: ${(e as Error).message}` });
      return true;
    }
  }

  if (method === 'GET' && !idMatch[2]) {
    const schedule = store.get(id);
    if (!schedule) {
      json(res, 404, { error: `unknown backup schedule: ${id}` });
      return true;
    }
    json(res, 200, { schedule });
    return true;
  }

  if (method === 'PATCH' && !idMatch[2]) {
    const existing = store.get(id);
    if (!existing) {
      json(res, 404, { error: `unknown backup schedule: ${id}` });
      return true;
    }
    const b = await readBody(req);
    const patch: Partial<
      Pick<BackupSchedule, 'name' | 'scheduleKind' | 'intervalMs' | 'cronExpr' | 'enabled' | 'nextRunAt'>
    > = {};
    if (b['name'] !== undefined) {
      if (typeof b['name'] !== 'string' || b['name'].trim().length === 0) {
        json(res, 400, { error: 'name must be a non-empty string' });
        return true;
      }
      patch.name = (b['name'] as string).trim();
    }
    if (b['enabled'] !== undefined) {
      if (typeof b['enabled'] !== 'boolean') {
        json(res, 400, { error: 'enabled must be a boolean' });
        return true;
      }
      patch.enabled = b['enabled'] as boolean;
    }
    let specChanged = false;
    const kind = b['scheduleKind'] ?? existing.scheduleKind;
    if (b['scheduleKind'] !== undefined || b['intervalMs'] !== undefined || b['cronExpr'] !== undefined) {
      try {
        const spec = validateSpec(
          kind,
          b['intervalMs'] !== undefined ? b['intervalMs'] : existing.intervalMs,
          b['cronExpr'] !== undefined ? b['cronExpr'] : existing.cronExpr,
        );
        patch.scheduleKind = spec.scheduleKind;
        patch.intervalMs = spec.intervalMs;
        patch.cronExpr = spec.cronExpr;
        specChanged = true;
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
        return true;
      }
    }
    if (specChanged) {
      // A respec'd schedule restarts its cadence from now — the old
      // next_run_at belonged to a different plan.
      patch.nextRunAt = computeNextRun(
        {
          scheduleKind: patch.scheduleKind ?? existing.scheduleKind,
          intervalMs: patch.intervalMs ?? existing.intervalMs,
          cronExpr: patch.cronExpr ?? existing.cronExpr,
        },
        new Date(),
      ).toISOString();
    }
    const actor = actorOf(b);
    const schedule = store.update(id, patch)!;
    audit.record(actor, 'BACKUP_SCHEDULE_UPDATED', 'backup_schedule', id, {
      name: schedule.name,
      patch: Object.keys(patch),
    });
    json(res, 200, { schedule });
    return true;
  }

  if (method === 'DELETE' && !idMatch[2]) {
    const existing = store.get(id);
    if (!existing) {
      json(res, 404, { error: `unknown backup schedule: ${id}` });
      return true;
    }
    const b = await readBody(req);
    const actor = actorOf(b);
    store.delete(id);
    audit.record(actor, 'BACKUP_SCHEDULE_DELETED', 'backup_schedule', id, {
      name: existing.name,
    });
    json(res, 200, { ok: true, id });
    return true;
  }

  return false;
}
