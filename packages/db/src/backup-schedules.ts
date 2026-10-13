/**
 * Backup schedules — Batch 20 (§47, backup retention companion).
 *
 * A schedule is an operator-configured plan the server's in-process
 * scheduler executes: kind 'interval' (every interval_ms, floor 60s)
 * or kind 'cron' (a 5-field cron expression, minute precision).
 * next_run_at is the next planned execution; the scheduler advances
 * it after every run and marks executions missed while the process
 * was down as MISSED on boot (no backfill — replaying a missed
 * backup could collide with a busy window; §47's safety posture).
 *
 * Durability note: schedules live in this table so a restart loses
 * nothing — the scheduler reconciles against these rows at startup.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type BackupScheduleKind = 'interval' | 'cron';
/** 'ok' | 'failed' after a run, 'MISSED' after boot reconcile. */
export type BackupScheduleStatus = 'ok' | 'failed' | 'MISSED';

export interface BackupSchedule {
  id: string;
  name: string;
  scheduleKind: BackupScheduleKind;
  intervalMs: number | null;
  cronExpr: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: BackupScheduleStatus | null;
  nextRunAt: string;
  createdAt: string;
  createdBy: string;
}

export interface NewBackupSchedule {
  name: string;
  scheduleKind: BackupScheduleKind;
  intervalMs?: number | null;
  cronExpr?: string | null;
  enabled?: boolean;
}

function rowToSchedule(r: Record<string, unknown>): BackupSchedule {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    scheduleKind: r['schedule_kind'] as BackupScheduleKind,
    intervalMs:
      r['interval_ms'] === null ? null : Number(r['interval_ms']),
    cronExpr: (r['cron_expr'] as string) ?? null,
    enabled: Number(r['enabled']) === 1,
    lastRunAt: (r['last_run_at'] as string) ?? null,
    lastStatus: (r['last_status'] as BackupScheduleStatus) ?? null,
    nextRunAt: r['next_run_at'] as string,
    createdAt: r['created_at'] as string,
    createdBy: r['created_by'] as string,
  };
}

export class SqliteBackupScheduleStore {
  constructor(private db: DatabaseSync) {}

  create(
    input: NewBackupSchedule,
    nextRunAtIso: string,
    actor: string,
    nowIso: string,
  ): BackupSchedule {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO backup_schedules
           (id, name, schedule_kind, interval_ms, cron_expr, enabled,
            last_run_at, last_status, next_run_at, created_at, created_by)
         VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.scheduleKind,
        input.scheduleKind === 'interval' ? (input.intervalMs ?? null) : null,
        input.scheduleKind === 'cron' ? (input.cronExpr ?? null) : null,
        input.enabled === false ? 0 : 1,
        nextRunAtIso,
        nowIso,
        actor,
      );
    return this.get(id)!;
  }

  get(id: string): BackupSchedule | undefined {
    const r = this.db
      .prepare('SELECT * FROM backup_schedules WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToSchedule(r) : undefined;
  }

  list(): BackupSchedule[] {
    return (
      this.db
        .prepare('SELECT * FROM backup_schedules ORDER BY created_at, id')
        .all() as Record<string, unknown>[]
    ).map(rowToSchedule);
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        BackupSchedule,
        | 'name'
        | 'scheduleKind'
        | 'intervalMs'
        | 'cronExpr'
        | 'enabled'
        | 'nextRunAt'
      >
    >,
  ): BackupSchedule | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE backup_schedules
         SET name = ?, schedule_kind = ?, interval_ms = ?, cron_expr = ?,
             enabled = ?, next_run_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.scheduleKind,
        next.scheduleKind === 'interval' ? next.intervalMs : null,
        next.scheduleKind === 'cron' ? next.cronExpr : null,
        next.enabled ? 1 : 0,
        next.nextRunAt,
        id,
      );
    return this.get(id)!;
  }

  /** Record one execution outcome (the scheduler's write). */
  recordRun(
    id: string,
    status: BackupScheduleStatus,
    ranAtIso: string,
    nextRunAtIso: string,
  ): BackupSchedule | undefined {
    const res = this.db
      .prepare(
        `UPDATE backup_schedules
         SET last_run_at = ?, last_status = ?, next_run_at = ?
         WHERE id = ?`,
      )
      .run(ranAtIso, status, nextRunAtIso, id);
    return Number(res.changes) === 0 ? undefined : this.get(id)!;
  }

  delete(id: string): boolean {
    const res = this.db
      .prepare('DELETE FROM backup_schedules WHERE id = ?')
      .run(id);
    return Number(res.changes) > 0;
  }
}
