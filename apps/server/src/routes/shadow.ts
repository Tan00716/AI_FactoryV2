/**
 * Shadow checkpoint routes — HTTP surface for the git-based sidecar
 * checkpoint layer (apps/server/src/shadow-checkpoints.ts).
 *
 *   GET    /api/shadow-checkpoints?workspaceId=   list checkpoints + config (viewer)
 *   POST   /api/shadow-checkpoints                {workspaceId, workspacePath, taskId?, label?} (operator)
 *   GET    /api/shadow-checkpoints/:id/diff?workspaceId=   diff vs parent (viewer)
 *   GET    /api/shadow-checkpoints/task-diff?workspaceId=&taskId=   task-scoped diff (viewer)
 *   POST   /api/shadow-checkpoints/:id/restore    {workspaceId, workspacePath} (operator)
 *   PUT    /api/shadow-checkpoints/config         {workspaceId, workspacePath,
 *                                                 autoOnToolUse?, autoOnRunStart?} (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET → viewer
 * and every other method → operator for this prefix — no auth.ts change
 * needed.
 *
 * Audit: SHADOW_CHECKPOINT_CREATED / SHADOW_CHECKPOINT_RESTORED /
 * SHADOW_CHECKPOINT_CONFIG_UPDATED.
 *
 * Automatic triggers (opt-in, per workspace config):
 * - run-start: executeRuntimeRun calls maybeShadowCheckpointOnRunStart(ctx,
 *   taskId, runId); it fires only when a config exists whose workspaceId
 *   equals the run's taskId AND autoOnRunStart is true. The run route has
 *   no workspace concept, so matching is by taskId-as-workspaceId — the
 *   same "caller must opt in" posture as the quality gate's runOnEdit.
 * - post-tool-use: routes/exec firePostToolUse calls
 *   maybeFireShadowCheckpoint(ctx, cwd); it fires only when the resolved
 *   cwd exactly matches a registered workspacePath with autoOnToolUse.
 * Both are fire-and-forget observers: they never throw into the caller
 * and never delay the response — the audit trail is the durable record.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { RouteContext } from './context';
import {
  restoreDbFromSnapshot,
  snapshotDbForCheckpoint,
  type DbSnapshotMeta,
} from '../db-time-travel';
import { dbTimeTravelStore, summarizeDbSnapshot } from './db-time-travel';
import {
  createShadowCheckpoint,
  diffShadowCheckpoints,
  restoreShadowCheckpoint,
  resolveWorkspacePath,
  ShadowCheckpointError,
  ShadowCheckpointStore,
  taskDiffRange,
  validateWorkspaceId,
  type ShadowCheckpoint,
} from '../shadow-checkpoints';

const PREFIX = '/api/shadow-checkpoints';

/** One store per process, like the other JSON-backed config stores. */
let store: ShadowCheckpointStore | null = null;
export function shadowCheckpointStore(): ShadowCheckpointStore {
  if (!store) store = new ShadowCheckpointStore();
  return store;
}
/** Test seam: swap the store (hermetic tests point it at a temp file). */
export function setShadowCheckpointStore(s: ShadowCheckpointStore | null): void {
  store = s;
}

function strOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function boolOf(v: unknown): boolean | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') return 'invalid';
  return v;
}

function toErrorBody(e: unknown): { status: number; body: { error: string; code: string } } {
  if (e instanceof ShadowCheckpointError) {
    const status =
      e.code === 'SHADOW_NOT_FOUND' || e.code === 'SHADOW_UNKNOWN_COMMIT'
        ? 404
        : e.code === 'SHADOW_GIT_UNAVAILABLE'
          ? 503
          : 400;
    return { status, body: { error: e.message, code: e.code } };
  }
  throw e;
}

function dbSnapshotSummary(checkpointId: string): Record<string, unknown> | null {
  try {
    const meta = dbTimeTravelStore().latestForCheckpoint(checkpointId);
    return meta ? summarizeDbSnapshot(meta) : null;
  } catch {
    return null;
  }
}

/** Snapshot the dev db for a fresh shadow checkpoint; audit the outcome.
 *  Never throws into the caller (observer posture) — failures become a
 *  SKIPPED audit entry, exactly like the skip statuses themselves. */
function snapshotDbForShadowCheckpoint(
  ctx: RouteContext,
  actor: 'human' | 'system',
  workspaceId: string,
  workspacePath: string,
  checkpointId: string,
  trigger: string,
): DbSnapshotMeta | null {
  try {
    const meta = snapshotDbForCheckpoint(dbTimeTravelStore(), {
      workspaceId,
      workspacePath,
      checkpointId,
      kind: 'checkpoint',
    });
    if (meta.status === 'ok') {
      ctx.audit.record(actor, 'DB_SNAPSHOT_CREATED', 'db-snapshot', checkpointId, {
        workspaceId,
        trigger,
        relPath: meta.relPath,
        size: meta.size,
        sha256: meta.sha256,
      });
    } else {
      ctx.audit.record(actor, 'DB_SNAPSHOT_SKIPPED', 'db-snapshot', checkpointId, {
        workspaceId,
        trigger,
        status: meta.status,
        reason: meta.reason,
      });
    }
    return meta;
  } catch (e) {
    try {
      ctx.audit.record(actor, 'DB_SNAPSHOT_SKIPPED', 'db-snapshot', checkpointId, {
        workspaceId,
        trigger,
        status: 'skipped-error',
        reason: (e as Error).message,
      });
    } catch {
      /* audit itself failed — nothing left to do */
    }
    return null;
  }
}

function summarize(cp: ShadowCheckpoint): Record<string, unknown> {
  return {
    id: cp.id,
    workspaceId: cp.workspaceId,
    taskId: cp.taskId,
    label: cp.label,
    auto: cp.auto,
    trigger: cp.trigger,
    createdAt: cp.createdAt,
    sha: cp.sha,
    parentSha: cp.parentSha,
    fileCount: cp.fileCount,
    additions: cp.additions,
    deletions: cp.deletions,
    empty: cp.empty,
    skipped: cp.skipped,
    skippedTotal: cp.skippedTotal,
    /** Latest db snapshot metadata for this checkpoint (same checkpoint id), or null. */
    db: dbSnapshotSummary(cp.id),
  };
}

// -------------------------------------------------- auto triggers ----

/** Post-tool-use observer — called from routes/exec firePostToolUse. Never throws. */
export function maybeFireShadowCheckpoint(ctx: RouteContext, cwd: string): void {
  void (async () => {
    try {
      const st = shadowCheckpointStore();
      let resolved: string;
      try {
        resolved = resolve(cwd);
      } catch {
        return;
      }
      for (const cfg of st.configsForPath(resolved)) {
        if (!cfg.autoOnToolUse) continue;
        const cp = createShadowCheckpoint(st, {
          workspaceId: cfg.workspaceId,
          workspacePath: cfg.workspacePath,
          auto: true,
          trigger: 'post-tool-use',
          label: 'auto snapshot after tool use',
        });
        ctx.audit.record('system', 'SHADOW_CHECKPOINT_CREATED', 'shadow-checkpoint', cp.id, {
          workspaceId: cfg.workspaceId,
          trigger: 'post-tool-use',
          empty: cp.empty,
        });
        snapshotDbForShadowCheckpoint(ctx, 'system', cfg.workspaceId, cfg.workspacePath, cp.id, 'post-tool-use');
      }
    } catch (e) {
      try {
        ctx.audit.record('system', 'SHADOW_CHECKPOINT_FAILED', 'shadow-checkpoint', cwd, {
          trigger: 'post-tool-use',
          error: (e as Error).message,
        });
      } catch {
        /* audit itself failed — nothing left to do */
      }
    }
  })().catch(() => {
    /* the checkpoint is an observer — it must never break exec */
  });
}

/** Run-start observer — called from executeRuntimeRun. Never throws. */
export function maybeShadowCheckpointOnRunStart(
  ctx: RouteContext,
  taskId: string,
  runId: string,
): void {
  void (async () => {
    try {
      const st = shadowCheckpointStore();
      const cfg = st.config(taskId);
      if (!cfg || !cfg.autoOnRunStart) return;
      const cp = createShadowCheckpoint(st, {
        workspaceId: cfg.workspaceId,
        workspacePath: cfg.workspacePath,
        taskId,
        auto: true,
        trigger: 'run-start',
        label: `auto snapshot before run ${runId}`,
      });
      ctx.audit.record('system', 'SHADOW_CHECKPOINT_CREATED', 'shadow-checkpoint', cp.id, {
        workspaceId: cfg.workspaceId,
        trigger: 'run-start',
        runId,
        taskId,
        empty: cp.empty,
      });
      snapshotDbForShadowCheckpoint(ctx, 'system', cfg.workspaceId, cfg.workspacePath, cp.id, 'run-start');
    } catch (e) {
      try {
        ctx.audit.record('system', 'SHADOW_CHECKPOINT_FAILED', 'shadow-checkpoint', runId, {
          trigger: 'run-start',
          taskId,
          error: (e as Error).message,
        });
      } catch {
        /* audit itself failed — nothing left to do */
      }
    }
  })().catch(() => {
    /* the checkpoint is an observer — it must never break run start */
  });
}

// -------------------------------------------------------- handler ----

export async function handleShadowRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const rest = path.slice(PREFIX.length);

  // GET /api/shadow-checkpoints?workspaceId= — list + config.
  if (method === 'GET' && rest === '') {
    const workspaceId = strOf(url.searchParams.get('workspaceId'), 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId query parameter is required', code: 'SHADOW_BAD_WORKSPACE_ID' });
      return true;
    }
    try {
      const st = shadowCheckpointStore();
      validateWorkspaceId(workspaceId);
      ctx.json(res, 200, {
        workspaceId,
        config: st.config(workspaceId),
        checkpoints: st.list(workspaceId).map(summarize),
      });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // GET /api/shadow-checkpoints/task-diff?workspaceId=&taskId=
  if (method === 'GET' && rest === '/task-diff') {
    const workspaceId = strOf(url.searchParams.get('workspaceId'), 64);
    const taskId = strOf(url.searchParams.get('taskId'), 128);
    if (!workspaceId || !taskId) {
      ctx.json(res, 400, { error: 'workspaceId and taskId query parameters are required' });
      return true;
    }
    try {
      const st = shadowCheckpointStore();
      const range = taskDiffRange(st, workspaceId, taskId);
      if (!range) {
        ctx.json(res, 404, { error: 'no shadow checkpoints for this task', code: 'SHADOW_NOT_FOUND' });
        return true;
      }
      const d = diffShadowCheckpoints(st, workspaceId, range.base, range.tip);
      ctx.json(res, 200, {
        workspaceId,
        taskId,
        base: range.base,
        tip: range.tip,
        checkpoints: range.checkpoints.map((c) => c.id),
        ...d,
      });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // GET /api/shadow-checkpoints/:id/diff?workspaceId=
  const diffMatch = rest.match(/^\/([^/]+)\/diff$/);
  if (method === 'GET' && diffMatch) {
    const workspaceId = strOf(url.searchParams.get('workspaceId'), 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId query parameter is required' });
      return true;
    }
    try {
      const st = shadowCheckpointStore();
      const cp = st.get(diffMatch[1]);
      if (!cp || cp.workspaceId !== workspaceId) {
        ctx.json(res, 404, { error: 'checkpoint not found in this workspace', code: 'SHADOW_NOT_FOUND' });
        return true;
      }
      const d = diffShadowCheckpoints(st, workspaceId, cp.parentSha ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', cp.sha);
      ctx.json(res, 200, { checkpoint: summarize(cp), ...d });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // POST /api/shadow-checkpoints — manual snapshot.
  if (method === 'POST' && rest === '') {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId is required', code: 'SHADOW_BAD_WORKSPACE_ID' });
      return true;
    }
    const taskId = strOf(body['taskId'], 128);
    const label = strOf(body['label'], 200);
    try {
      const st = shadowCheckpointStore();
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      const cp = createShadowCheckpoint(st, {
        workspaceId,
        workspacePath,
        taskId,
        label: label ?? 'manual snapshot',
        auto: false,
        trigger: 'manual',
      });
      ctx.audit.record('human', 'SHADOW_CHECKPOINT_CREATED', 'shadow-checkpoint', cp.id, {
        workspaceId,
        taskId: cp.taskId,
        label: cp.label,
        trigger: 'manual',
        empty: cp.empty,
        fileCount: cp.fileCount,
      });
      const dbMeta = snapshotDbForShadowCheckpoint(ctx, 'human', workspaceId, workspacePath, cp.id, 'manual');
      ctx.json(res, 201, { checkpoint: summarize(cp), dbSnapshot: dbMeta ? summarizeDbSnapshot(dbMeta) : null });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // POST /api/shadow-checkpoints/:id/restore — one-click undo.
  // Optional data restore: body.restoreDb=true (default OFF) + confirm=true
  // restores the checkpoint's dev-db snapshot too. Restore only ever writes
  // the DEV path (see db-time-travel.ts); prod is unreachable from here.
  const restoreMatch = rest.match(/^\/([^/]+)\/restore$/);
  if (method === 'POST' && restoreMatch) {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId is required', code: 'SHADOW_BAD_WORKSPACE_ID' });
      return true;
    }
    const wantDb = body['restoreDb'] === true;
    if (wantDb && body['confirm'] !== true) {
      // Fail fast BEFORE touching code or data: data restore is a
      // deliberate, separately-confirmed decision.
      ctx.json(res, 400, {
        error: 'restoreDb requires explicit confirmation (confirm: true)',
        code: 'DB_CONFIRM_REQUIRED',
      });
      return true;
    }
    try {
      const st = shadowCheckpointStore();
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      if (wantDb) {
        // Pre-validate the db side before modifying anything.
        const dbSt = dbTimeTravelStore();
        if (!dbSt.latestOkForCheckpoint(restoreMatch[1])) {
          ctx.json(res, 404, {
            error: 'checkpoint has no usable db snapshot — code restore aborted, nothing modified',
            code: 'DB_NO_SNAPSHOT',
          });
          return true;
        }
      }
      const r = restoreShadowCheckpoint(st, { workspaceId, workspacePath, checkpointId: restoreMatch[1] });
      ctx.audit.record('human', 'SHADOW_CHECKPOINT_RESTORED', 'shadow-checkpoint', r.restoredId, {
        workspaceId,
        sha: r.sha,
        backupId: r.backup?.id ?? null,
        leftInPlace: r.leftInPlace.length,
        restoreDb: wantDb,
      });
      let dbRestore: Record<string, unknown> | null = null;
      if (wantDb) {
        const dr = restoreDbFromSnapshot(dbTimeTravelStore(), {
          workspaceId,
          workspacePath,
          checkpointId: restoreMatch[1],
          confirm: true,
        });
        ctx.audit.record('human', 'DB_RESTORED', 'db-snapshot', restoreMatch[1], {
          workspaceId,
          relPath: dr.relPath,
          size: dr.size,
          sha256: dr.sha256,
          preRestoreId: dr.preRestore?.id ?? null,
          via: 'shadow-checkpoint-restore',
        });
        dbRestore = {
          relPath: dr.relPath,
          size: dr.size,
          sha256: dr.sha256,
          preRestore: dr.preRestore ? summarizeDbSnapshot(dr.preRestore) : null,
        };
      }
      ctx.json(res, 200, {
        restoredId: r.restoredId,
        sha: r.sha,
        backup: r.backup ? summarize(r.backup) : null,
        leftInPlace: r.leftInPlace,
        dbRestore,
      });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // PUT /api/shadow-checkpoints/config — register path + auto toggles.
  if (method === 'PUT' && rest === '/config') {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId is required', code: 'SHADOW_BAD_WORKSPACE_ID' });
      return true;
    }
    const autoOnToolUse = boolOf(body['autoOnToolUse']);
    const autoOnRunStart = boolOf(body['autoOnRunStart']);
    if (autoOnToolUse === 'invalid' || autoOnRunStart === 'invalid') {
      ctx.json(res, 400, { error: 'autoOnToolUse/autoOnRunStart must be booleans when provided' });
      return true;
    }
    try {
      const st = shadowCheckpointStore();
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      const prev = st.config(workspaceId);
      const cfg = {
        workspaceId,
        workspacePath,
        autoOnToolUse: autoOnToolUse ?? prev?.autoOnToolUse ?? false,
        autoOnRunStart: autoOnRunStart ?? prev?.autoOnRunStart ?? false,
        updatedAt: new Date().toISOString(),
      };      st.setConfig(cfg);
      ctx.audit.record('human', 'SHADOW_CHECKPOINT_CONFIG_UPDATED', 'shadow-checkpoint', workspaceId, {
        workspacePath,
        autoOnToolUse: cfg.autoOnToolUse,
        autoOnRunStart: cfg.autoOnRunStart,
      });
      ctx.json(res, 200, { config: cfg });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  return false;
}
