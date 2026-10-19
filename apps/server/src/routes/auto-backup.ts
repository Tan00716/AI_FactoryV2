/**
 * Automatic backup policy routes — the operator surface for the
 * auto-backup policy (apps/server/src/auto-backup.ts).
 *
 *   GET  /api/auto-backup        current policy (viewer)
 *   PUT  /api/auto-backup        update policy {enabled, kind, cronExpr,
 *                                intervalMs, retainCount, healthCheck}
 *                                (operator; re-syncs the owned schedule)
 *   POST /api/auto-backup/run    run one guarded backup now (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no
 * auth.ts change needed. This matches /api/schedules (the general
 * scheduler this policy drives); the backup *artifacts* themselves
 * stay admin behind /api/backups.
 *
 * The coordinator (index.ts) calls syncAutoBackupPolicy(routeCtx) once
 * at boot (after initTaskScheduler) so an enabled policy survives
 * restarts; the function never throws — the server must start even
 * when the policy file is broken (the breakage is audited).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteContext } from './context';
import {
  AutoBackupError,
  autoBackupPolicyPath,
  checkLiveDbIntegrity,
  loadPolicy,
  runGuardedBackup,
  syncPolicySchedule,
  validatePolicyInput,
  validateScheduleSpec,
  writePolicyFile,
  type GuardedBackupDeps,
} from '../auto-backup';
import {
  backupDirPath,
  createBackup,
  listBackupManifests,
  stagedRestoreBackupId,
} from './backup';
import { scheduleStore } from './schedules';

const PREFIX = '/api/auto-backup';

function guardDeps(ctx: RouteContext): GuardedBackupDeps {
  return {
    audit: {
      record: (actor, event, entityType, entityId, details) =>
        ctx.audit.record(actor, event, entityType, entityId, details),
    },
    createBackup: (kind: 'manual' | 'scheduled') => createBackup(ctx.fdb, kind),
    listBackups: () => listBackupManifests(),
    // Defense in depth: pruneOldBackups already safety-validated the
    // id; re-check here so a future caller cannot rmSync an arbitrary
    // path through this closure.
    deleteBackupDir: (backupId: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId) || backupId.includes('..')) {
        throw new Error(`refusing to delete backup with unsafe id: ${backupId}`);
      }
      rmSync(join(backupDirPath(), backupId), { recursive: true, force: true });
    },
    stagedRestoreBackupId: () => stagedRestoreBackupId(),
    activeHoldCount: () => ctx.fdb.retention.countActiveHolds(),
    checkLiveDbIntegrity: () => checkLiveDbIntegrity(ctx.fdb),
  };
}

/**
 * Boot-time reconciliation of the policy-owned schedule. Never throws:
 * a broken policy file (or store) must not take the server down — the
 * failure is logged and the policy simply does not schedule until an
 * operator fixes it via PUT.
 */
export function syncAutoBackupPolicy(ctx: RouteContext): void {
  try {
    syncPolicySchedule({ ...guardDeps(ctx), store: scheduleStore() });
  } catch (e) {
    console.error('auto-backup policy sync failed:', (e as Error).message);
  }
}

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

export async function handleAutoBackupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/auto-backup — current policy.
  if (method === 'GET' && path === PREFIX) {
    const { policy, corrupt } = loadPolicy();
    if (corrupt) {
      ctx.json(res, 500, {
        error: 'auto-backup policy file is corrupt; fix or remove it, then retry',
      });
      return true;
    }
    ctx.json(res, 200, { policy });
    return true;
  }

  // PUT /api/auto-backup — update the policy, re-sync the schedule.
  if (method === 'PUT' && path === PREFIX) {
    if (loadPolicy().corrupt) {
      ctx.json(res, 500, {
        error: 'auto-backup policy file is corrupt; fix or remove it, then retry',
      });
      return true;
    }
    const body = (await ctx.readBody(req).catch(() => ({} as Record<string, unknown>))) ?? {};
    try {
      const patch = validatePolicyInput(body);
      const { policy: current } = loadPolicy();
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      if (next.enabled) validateScheduleSpec(next);
      writePolicyFile(autoBackupPolicyPath(), next);
      const sync = syncPolicySchedule({ ...guardDeps(ctx), store: scheduleStore() });
      // The sync persists the owned scheduleId — re-read so the
      // response (and audit) reflects the reconciled state, not the
      // pre-sync draft.
      const { policy: synced } = loadPolicy(autoBackupPolicyPath());
      ctx.audit.record(actorOf(body), 'AUTO_BACKUP_POLICY_UPDATED', 'auto-backup', 'policy', {
        enabled: synced.enabled,
        kind: synced.kind,
        retainCount: synced.retainCount,
        sync: sync.action,
      });
      ctx.json(res, 200, { policy: synced, sync: sync.action });
    } catch (e) {
      if (e instanceof AutoBackupError) {
        ctx.json(res, 400, { error: e.message });
        return true;
      }
      throw e;
    }
    return true;
  }

  // POST /api/auto-backup/run — one guarded backup right now.
  // A manual trigger is kind 'manual': the operator's one-off backup
  // is exempt from the keep-newest-N retention (which only prunes
  // kind 'scheduled').
  if (method === 'POST' && path === PREFIX + '/run') {
    try {
      const { backupId, pruned } = runGuardedBackup(guardDeps(ctx), 'manual');
      ctx.audit.record('human', 'AUTO_BACKUP_MANUAL', 'auto-backup', backupId, {
        backupId,
        pruned,
      });
      ctx.json(res, 200, { backupId, pruned });
    } catch (e) {
      if (e instanceof AutoBackupError) {
        // Health-check skip: 409 would imply a conflict; 422 would
        // imply bad input — neither fits. The skip is a recorded,
        // audited refusal: 503 with the reason states it plainly.
        const skipped = (e as Error).message.includes('health check failed');
        ctx.json(res, skipped ? 503 : 500, { error: (e as Error).message });
        return true;
      }
      throw e;
    }
    return true;
  }

  return false;
}
