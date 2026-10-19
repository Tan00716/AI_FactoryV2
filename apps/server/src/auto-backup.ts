/**
 * Automatic backup policy — the operator-facing policy layer on top of
 * the general TaskScheduler (scheduler.ts, task 2 of this wave).
 *
 * Motivation: backup/restore was manual-only plus the old Batch-20
 * backup-only SQLite scheduler (§47). The new TaskScheduler already
 * knows a `backup` job type; this module is the *policy* that drives
 * it: enable/disable, cadence (cron or interval), how many scheduled
 * snapshots to keep, and a pre-backup health gate.
 *
 * Design notes:
 *  - The policy is ONE JSON file (atomic temp+rename writes, corrupt
 *    fail-closed — the session-store pattern). When enabled, the
 *    policy owns exactly one schedule in the TaskScheduler store
 *    (name 'auto-backup (policy)', createdBy 'auto-backup-policy');
 *    syncPolicySchedule() reconciles it idempotently at boot and on
 *    every PUT.
 *  - runGuardedBackup() is what the scheduler's `backup` job dep calls
 *    (wired in routes/schedules.ts initTaskScheduler). It gates every
 *    scheduled backup on a live-DB PRAGMA quick_check: a corrupt
 *    database is never snapshotted — the firing is skipped and audited
 *    (AUTO_BACKUP_SKIPPED), never silently dropped.
 *  - Retention ("keep newest N") runs after a successful guarded
 *    backup, only when the policy is enabled. It deletes ONLY
 *    kind='scheduled' backup directories, never 'manual',
 *    never 'pre-restore' (the rollback safety net), never the backup
 *    staged for a pending restore, and nothing at all while any legal
 *    hold is active (mirrors the §47 retention posture: a backup is a
 *    whole-database snapshot, so ANY active hold exempts ALL backups).
 *    A corrupt/unreadable policy file disables retention — retention
 *    never deletes blind.
 *  - This module is deliberately pure: node builtins + the scheduler's
 *    pure helpers only. All side effects (createBackup, listing,
 *    deletion, holds, integrity check, audit) are injected through
 *    GuardedBackupDeps so tests run without a database.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MIN_INTERVAL_MS, parseCronExpr, type Schedule, type ScheduleStore } from './scheduler';
import type { BackupManifest } from './routes/backup';
import type { FactoryDatabase } from '@ai-factory/db';

/** Name of the single schedule the policy owns in the TaskScheduler store. */
export const AUTO_BACKUP_SCHEDULE_NAME = 'auto-backup (policy)';
/** createdBy marker so the sync can tell its schedule apart. */
export const AUTO_BACKUP_CREATED_BY = 'auto-backup-policy';

export const DEFAULT_RETAIN_COUNT = 7;
export const MAX_RETAIN_COUNT = 365;
/** Default cadence when the operator just flips the switch: daily. */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AutoBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoBackupError';
  }
}

export interface AutoBackupPolicy {
  enabled: boolean;
  kind: 'cron' | 'interval';
  cronExpr: string | null;
  intervalMs: number | null;
  /** Keep the newest N scheduled backups; 1..365. */
  retainCount: number;
  /** Gate every scheduled backup on a live-DB PRAGMA quick_check. */
  healthCheck: boolean;
  /** Id of the owned schedule in the TaskScheduler store (null when none). */
  scheduleId: string | null;
  updatedAt: string;
}

export function autoBackupPolicyPath(): string {
  const fromEnv = process.env.AI_FACTORY_AUTO_BACKUP_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'auto-backup-policy.json');
}

export function defaultAutoBackupPolicy(): AutoBackupPolicy {
  return {
    enabled: false,
    kind: 'interval',
    cronExpr: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    retainCount: DEFAULT_RETAIN_COUNT,
    healthCheck: true,
    scheduleId: null,
    updatedAt: new Date().toISOString(),
  };
}

function atomicWriteJson(path: string, payload: unknown): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Validated operator input for PUT /api/auto-backup (partial updates allowed). */
export interface PolicyPatch {
  enabled?: boolean;
  kind?: 'cron' | 'interval';
  cronExpr?: string | null;
  intervalMs?: number | null;
  retainCount?: number;
  healthCheck?: boolean;
}

/**
 * Validate a PUT body. Throws AutoBackupError on the first problem.
 * Cross-field rule: kind 'cron' requires cronExpr, kind 'interval'
 * requires intervalMs — validated against the *merged* policy by the
 * caller (validateScheduleSpec), because a PATCH may set kind alone.
 */
export function validatePolicyInput(body: unknown): PolicyPatch {
  if (!body || typeof body !== 'object') throw new AutoBackupError('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  const patch: PolicyPatch = {};
  if (b['enabled'] !== undefined) {
    if (typeof b['enabled'] !== 'boolean') throw new AutoBackupError('enabled must be a boolean');
    patch.enabled = b['enabled'];
  }
  if (b['kind'] !== undefined) {
    if (b['kind'] !== 'cron' && b['kind'] !== 'interval') {
      throw new AutoBackupError("kind must be 'cron' or 'interval'");
    }
    patch.kind = b['kind'];
  }
  if (b['cronExpr'] !== undefined) {
    if (b['cronExpr'] !== null && typeof b['cronExpr'] !== 'string') {
      throw new AutoBackupError('cronExpr must be a string or null');
    }
    const expr = (b['cronExpr'] as string | null)?.trim() || null;
    if (expr) {
      try {
        parseCronExpr(expr);
      } catch (e) {
        throw new AutoBackupError(`invalid cronExpr: ${(e as Error).message}`);
      }
    }
    patch.cronExpr = expr;
  }
  if (b['intervalMs'] !== undefined) {
    if (b['intervalMs'] !== null && typeof b['intervalMs'] !== 'number') {
      throw new AutoBackupError('intervalMs must be a number or null');
    }
    const ms = b['intervalMs'] as number | null;
    if (ms !== null && (!Number.isInteger(ms) || ms < MIN_INTERVAL_MS)) {
      throw new AutoBackupError(`intervalMs must be an integer >= ${MIN_INTERVAL_MS} ms (60s)`);
    }
    patch.intervalMs = ms;
  }
  if (b['retainCount'] !== undefined) {
    if (typeof b['retainCount'] !== 'number' || !Number.isInteger(b['retainCount'])) {
      throw new AutoBackupError('retainCount must be an integer');
    }
    if (b['retainCount'] < 1 || b['retainCount'] > MAX_RETAIN_COUNT) {
      throw new AutoBackupError(`retainCount must be between 1 and ${MAX_RETAIN_COUNT}`);
    }
    patch.retainCount = b['retainCount'];
  }
  if (b['healthCheck'] !== undefined) {
    if (typeof b['healthCheck'] !== 'boolean') throw new AutoBackupError('healthCheck must be a boolean');
    patch.healthCheck = b['healthCheck'];
  }
  return patch;
}

/** The cadence part of a policy must be self-consistent before it may be scheduled. */
export function validateScheduleSpec(p: Pick<AutoBackupPolicy, 'kind' | 'cronExpr' | 'intervalMs'>): void {
  if (p.kind === 'cron') {
    if (!p.cronExpr) throw new AutoBackupError("kind 'cron' requires cronExpr");
    try {
      parseCronExpr(p.cronExpr);
    } catch (e) {
      throw new AutoBackupError(`invalid cronExpr: ${(e as Error).message}`);
    }
  } else {
    if (p.intervalMs === null || p.intervalMs === undefined) {
      throw new AutoBackupError("kind 'interval' requires intervalMs");
    }
    if (!Number.isInteger(p.intervalMs) || p.intervalMs < MIN_INTERVAL_MS) {
      throw new AutoBackupError(`intervalMs must be an integer >= ${MIN_INTERVAL_MS} ms (60s)`);
    }
  }
}

export interface PolicyLoad {
  policy: AutoBackupPolicy;
  /** True when the file exists but is unreadable or fails validation. */
  corrupt: boolean;
}

function isValidStoredPolicy(raw: unknown): raw is AutoBackupPolicy {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Record<string, unknown>;
  try {
    // Reuse the field validators; kind/cronExpr/intervalMs cross-check
    // is done by validateScheduleSpec so a disabled policy with an
    // incomplete cadence still loads (it just cannot be enabled until
    // the cadence is complete — enforced at PUT/sync time).
    validatePolicyInput({
      enabled: p['enabled'],
      retainCount: p['retainCount'],
      healthCheck: p['healthCheck'],
      ...(p['kind'] !== undefined ? { kind: p['kind'] } : {}),
      ...(p['cronExpr'] !== undefined ? { cronExpr: p['cronExpr'] } : {}),
      ...(p['intervalMs'] !== undefined ? { intervalMs: p['intervalMs'] } : {}),
    });
  } catch {
    return false;
  }
  if (typeof p['enabled'] !== 'boolean') return false;
  if (p['kind'] !== 'cron' && p['kind'] !== 'interval') return false;
  if (typeof p['retainCount'] !== 'number' || typeof p['healthCheck'] !== 'boolean') return false;
  if (p['scheduleId'] !== null && typeof p['scheduleId'] !== 'string') return false;
  return true;
}

/**
 * Load the policy. Missing file → defaults (disabled). Corrupt file →
 * corrupt=true with defaults; callers must refuse to schedule or
 * persist while corrupt (fail-closed: retention never deletes blind).
 */
export function loadPolicy(path: string = autoBackupPolicyPath()): PolicyLoad {
  if (!existsSync(path)) return { policy: defaultAutoBackupPolicy(), corrupt: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const p = (raw as { policy?: unknown }).policy ?? raw;
    if (!isValidStoredPolicy(p)) return { policy: defaultAutoBackupPolicy(), corrupt: true };
    return { policy: { ...defaultAutoBackupPolicy(), ...p }, corrupt: false };
  } catch {
    return { policy: defaultAutoBackupPolicy(), corrupt: true };
  }
}

/** Persist the policy (atomic). Throws AutoBackupError when the existing file is corrupt. */
export function writePolicyFile(path: string, policy: AutoBackupPolicy): void {
  if (loadPolicy(path).corrupt) {
    throw new AutoBackupError(
      'auto-backup policy file is corrupt; refusing writes — fix or remove the file, then retry',
    );
  }
  atomicWriteJson(path, { policy });
}

// ------------------------------------------------------------ scheduler --

export interface AuditRecorder {
  record(
    actor: string,
    event: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ): void;
}

/** Everything runGuardedBackup/pruning touches — injected for testability. */
export interface GuardedBackupDeps {
  policyPath?: string;
  audit: AuditRecorder;
  createBackup(kind: 'manual' | 'scheduled'): { backupId: string };
  listBackups(): BackupManifest[];
  /**
   * Delete one backup directory by id. The id is safety-validated by
   * pruneOldBackups before this is called (defense in depth: the real
   * implementation re-checks).
   */
  deleteBackupDir(backupId: string): void;
  stagedRestoreBackupId(): string | null;
  activeHoldCount(): number;
  /** 'ok' when the live DB passes PRAGMA quick_check, else a description. */
  checkLiveDbIntegrity(): string;
}

export interface PolicySyncDeps extends GuardedBackupDeps {
  store: ScheduleStore;
}

export type SyncAction = 'created' | 'recreated' | 'removed' | 'noop' | 'skipped-corrupt';

function isPolicySchedule(s: Schedule): boolean {
  return s.name === AUTO_BACKUP_SCHEDULE_NAME && (s.job as { type?: string }).type === 'backup';
}

/**
 * Find the schedule this policy owns: by recorded scheduleId first,
 * falling back to the name/createdBy marker scan. The fallback covers
 * a hand-edited policy file that lost its scheduleId — the owned
 * schedule must never become an orphan the sync cannot see.
 */
function findOwnedSchedule(store: ScheduleStore, policy: AutoBackupPolicy): Schedule | undefined {
  if (policy.scheduleId) {
    const byId = store.get(policy.scheduleId);
    if (byId && isPolicySchedule(byId)) return byId;
  }
  return store.list().find(isPolicySchedule);
}

function specMatches(s: Schedule, p: AutoBackupPolicy): boolean {
  return (
    s.kind === p.kind &&
    (s.cronExpr ?? null) === (p.cronExpr ?? null) &&
    (s.intervalMs ?? null) === (p.intervalMs ?? null) &&
    s.status === 'active'
  );
}

/**
 * Reconcile the one schedule the policy owns. Idempotent: enabling an
 * already-correct policy is a noop; changing the cadence recreates;
 * disabling removes. Never throws for a dangling scheduleId (the
 * operator may have deleted the schedule by hand — it is recreated).
 */
export function syncPolicySchedule(deps: PolicySyncDeps): { action: SyncAction; scheduleId: string | null } {
  const path = deps.policyPath ?? autoBackupPolicyPath();
  const { policy, corrupt } = loadPolicy(path);
  if (corrupt) {
    deps.audit.record('system', 'AUTO_BACKUP_POLICY_CORRUPT', 'auto-backup', 'policy', { path });
    return { action: 'skipped-corrupt', scheduleId: null };
  }
  const existing = findOwnedSchedule(deps.store, policy);
  const owned = existing;

  if (!policy.enabled) {
    if (owned) {
      deps.store.remove(owned.id);
      deps.audit.record('system', 'AUTO_BACKUP_SCHEDULE_REMOVED', 'auto-backup', owned.id, {});
    }
    if (policy.scheduleId !== null) {
      policy.scheduleId = null;
      policy.updatedAt = new Date().toISOString();
      writePolicyFile(path, policy);
    }
    return { action: owned ? 'removed' : 'noop', scheduleId: null };
  }

  validateScheduleSpec(policy);
  if (owned && specMatches(owned, policy)) {
    // Adopt a marker-found schedule (scheduleId was lost): record the id.
    if (policy.scheduleId !== owned.id) {
      policy.scheduleId = owned.id;
      policy.updatedAt = new Date().toISOString();
      writePolicyFile(path, policy);
    }
    return { action: 'noop', scheduleId: owned.id };
  }
  if (owned) deps.store.remove(owned.id);
  const s = deps.store.create({
    name: AUTO_BACKUP_SCHEDULE_NAME,
    kind: policy.kind,
    ...(policy.kind === 'cron' ? { cronExpr: policy.cronExpr as string } : { intervalMs: policy.intervalMs as number }),
    job: { type: 'backup' },
    createdBy: AUTO_BACKUP_CREATED_BY,
  });
  policy.scheduleId = s.id;
  policy.updatedAt = new Date().toISOString();
  writePolicyFile(path, policy);
  deps.audit.record('system', 'AUTO_BACKUP_SCHEDULE_SYNCED', 'auto-backup', s.id, {
    kind: policy.kind,
    cronExpr: policy.cronExpr,
    intervalMs: policy.intervalMs,
    recreated: owned ? true : undefined,
  });
  return { action: owned ? 'recreated' : 'created', scheduleId: s.id };
}

// ------------------------------------------------------------- guarded --

/** Backup ids are directory names — validate before any rmSync, never delete blind. */
const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isSafeBackupId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 128 &&
    BACKUP_ID_RE.test(id) &&
    !id.includes('..')
  );
}

/**
 * Delete scheduled backup directories beyond the newest `retainCount`.
 * Exemptions (never deleted): manual and pre-restore backups, the
 * backup staged for a pending restore, anything while a legal hold is
 * active, and ids that fail the safety regex. Returns pruned ids.
 */
export function pruneOldBackups(deps: GuardedBackupDeps, retainCount: number): string[] {
  if (deps.activeHoldCount() > 0) {
    deps.audit.record('system', 'AUTO_BACKUP_PRUNE_DEFERRED', 'auto-backup', 'retention', {
      reason: 'active legal hold exempts all backups',
    });
    return [];
  }
  const staged = deps.stagedRestoreBackupId();
  const candidates = deps
    .listBackups()
    .filter((m) => m.kind === 'scheduled')
    .filter((m) => m.backupId !== staged)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const victims = candidates.slice(Math.max(1, Math.floor(retainCount)));
  const pruned: string[] = [];
  for (const m of victims) {
    if (!isSafeBackupId(m.backupId)) {
      deps.audit.record('system', 'AUTO_BACKUP_PRUNE_REJECTED', 'auto-backup', m.backupId, {
        reason: 'backup id failed safety validation; refusing to delete',
      });
      continue;
    }
    try {
      deps.deleteBackupDir(m.backupId);
      pruned.push(m.backupId);
    } catch (e) {
      deps.audit.record('system', 'AUTO_BACKUP_PRUNE_FAILED', 'auto-backup', m.backupId, {
        error: (e as Error).message.slice(0, 300),
      });
    }
  }
  if (pruned.length > 0) {
    deps.audit.record('system', 'AUTO_BACKUP_PRUNED', 'auto-backup', 'retention', {
      pruned,
      retainCount,
    });
  }
  return pruned;
}

/**
 * The scheduler's `backup` job entry point (wired in
 * routes/schedules.ts). Gates on the pre-backup health check, creates
 * the backup through the same createBackup() the manual endpoint uses,
 * then enforces the keep-newest-N retention when the policy is
 * enabled. A failed health check throws AutoBackupError — the
 * scheduler records the firing as failed (SCHEDULE_FAILED) and the
 * skip itself is audited here (AUTO_BACKUP_SKIPPED).
 *
 * `kind` is the manifest kind: scheduler firings are 'scheduled' (and
 * subject to retention); the POST /api/auto-backup/run manual trigger
 * passes 'manual' so an operator's one-off backup is never pruned.
 */
export function runGuardedBackup(
  deps: GuardedBackupDeps,
  kind: 'manual' | 'scheduled' = 'scheduled',
): { backupId: string; pruned: string[] } {
  const { policy, corrupt } = loadPolicy(deps.policyPath ?? autoBackupPolicyPath());
  // Fail-closed: a corrupt policy file cannot disable the safety gate,
  // but retention stays off (retention never deletes blind).
  const healthCheck = corrupt ? true : policy.healthCheck;
  if (healthCheck) {
    let verdict: string;
    try {
      verdict = deps.checkLiveDbIntegrity();
    } catch (e) {
      verdict = `integrity probe failed: ${(e as Error).message}`;
    }
    if (verdict !== 'ok') {
      deps.audit.record('system', 'AUTO_BACKUP_SKIPPED', 'auto-backup', 'live-db', {
        reason: verdict.slice(0, 500),
      });
      throw new AutoBackupError(`pre-backup health check failed (${verdict}); backup skipped`);
    }
  }
  const { backupId } = deps.createBackup(kind);
  deps.audit.record('system', 'AUTO_BACKUP_COMPLETED', 'auto-backup', backupId, { backupId, kind });
  const pruned = !corrupt && policy.enabled ? pruneOldBackups(deps, policy.retainCount) : [];
  return { backupId, pruned };
}

/**
 * Live-DB health probe for the pre-backup gate: PRAGMA quick_check is
 * the cheap read-side gate (createBackup() itself runs the full
 * integrity_check on the snapshot and refuses to complete on
 * corruption — this gate skips the snapshot attempt entirely).
 */
export function checkLiveDbIntegrity(fdb: FactoryDatabase): string {
  const row = fdb.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  const verdict = row?.['quick_check'];
  return verdict === 'ok' ? 'ok' : `quick_check: ${JSON.stringify(verdict)}`;
}
