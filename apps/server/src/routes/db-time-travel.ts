/**
 * DB time-travel routes — HTTP surface for the data side of shadow
 * checkpoints (apps/server/src/db-time-travel.ts).
 *
 *   GET  /api/db-time-travel/config?workspaceId=&workspacePath=   (viewer)
 *   PUT  /api/db-time-travel/config                               (operator)
 *          { workspaceId, workspacePath, dev, prod?, snapshotOnCheckpoint?, maxBytes? }
 *   GET  /api/db-time-travel/snapshots?workspaceId=[&checkpointId=] (viewer)
 *   POST /api/db-time-travel/restore-db                           (operator)
 *          { workspaceId, workspacePath, checkpointId, confirm: true }
 *          — restores the DEV database only; prod is unreachable here.
 *   POST /api/db-time-travel/promote                              (operator)
 *          { workspaceId, workspacePath, checkpointId, confirm: true }
 *          — the ONLY prod write path: explicit action + confirm + audit.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET → viewer
 * and every other method → operator for this prefix — no auth.ts change
 * needed.
 *
 * Audit: DB_CONFIG_UPDATED / DB_RESTORED / DB_PROMOTE. Snapshot creation
 * audits (DB_SNAPSHOT_CREATED / DB_SNAPSHOT_SKIPPED) live at the shadow
 * checkpoint creation sites in routes/shadow.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import { resolveWorkspacePath } from '../shadow-checkpoints';
import {
  DbTimeTravelError,
  DbTimeTravelStore,
  promoteDbToProd,
  readDbConfig,
  restoreDbFromSnapshot,
  validateDbConfig,
  validateDbWorkspaceId,
  writeDbConfig,
  type DbSnapshotMeta,
} from '../db-time-travel';

const PREFIX = '/api/db-time-travel';

/** One store per process, mirroring the shadow checkpoint store. */
let store: DbTimeTravelStore | null = null;
export function dbTimeTravelStore(): DbTimeTravelStore {
  if (!store) store = new DbTimeTravelStore();
  return store;
}
/** Test seam: swap the store (hermetic tests point it at a temp file). */
export function setDbTimeTravelStore(s: DbTimeTravelStore | null): void {
  store = s;
}

function strOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function toErrorBody(e: unknown): { status: number; body: { error: string; code: string } } {
  if (e instanceof DbTimeTravelError) {
    const status =
      e.code === 'DB_NO_SNAPSHOT'
        ? 404
        : e.code === 'DB_CONFIRM_REQUIRED' || e.code === 'DB_PROD_RESTORE_REFUSED'
          ? 400
          : 400;
    return { status, body: { error: e.message, code: e.code } };
  }
  throw e;
}

export function summarizeDbSnapshot(m: DbSnapshotMeta): Record<string, unknown> {
  return {
    id: m.id,
    checkpointId: m.checkpointId,
    workspaceId: m.workspaceId,
    kind: m.kind,
    relPath: m.relPath,
    env: m.env,
    size: m.size,
    sha256: m.sha256,
    status: m.status,
    reason: m.reason,
    createdAt: m.createdAt,
  };
}

export async function handleDbTimeTravelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const rest = path.slice(PREFIX.length);

  // GET /api/db-time-travel/config?workspaceId=&workspacePath=
  if (method === 'GET' && rest === '/config') {
    const workspaceId = strOf(url.searchParams.get('workspaceId'), 64);
    const workspacePathRaw = url.searchParams.get('workspacePath');
    if (!workspaceId || !workspacePathRaw) {
      ctx.json(res, 400, { error: 'workspaceId and workspacePath query parameters are required' });
      return true;
    }
    try {
      validateDbWorkspaceId(workspaceId);
      const workspacePath = resolveWorkspacePath(workspacePathRaw);
      ctx.json(res, 200, { workspaceId, config: readDbConfig(workspacePath) });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // PUT /api/db-time-travel/config — declare dev/prod db paths.
  if (method === 'PUT' && rest === '/config') {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId is required', code: 'DB_BAD_WORKSPACE_ID' });
      return true;
    }
    try {
      validateDbWorkspaceId(workspaceId);
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      const cfg = validateDbConfig({
        dev: body['dev'],
        prod: body['prod'],
        snapshotOnCheckpoint: body['snapshotOnCheckpoint'],
        maxBytes: body['maxBytes'],
      });
      const saved = writeDbConfig(workspacePath, cfg);
      ctx.audit.record('human', 'DB_CONFIG_UPDATED', 'db-config', workspaceId, {
        dev: saved.dev,
        prod: saved.prod ?? null,
        snapshotOnCheckpoint: saved.snapshotOnCheckpoint,
        maxBytes: saved.maxBytes ?? null,
      });
      ctx.json(res, 200, { workspaceId, config: saved });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // GET /api/db-time-travel/snapshots?workspaceId=[&checkpointId=]
  if (method === 'GET' && rest === '/snapshots') {
    const workspaceId = strOf(url.searchParams.get('workspaceId'), 64);
    if (!workspaceId) {
      ctx.json(res, 400, { error: 'workspaceId query parameter is required', code: 'DB_BAD_WORKSPACE_ID' });
      return true;
    }
    const checkpointId = strOf(url.searchParams.get('checkpointId'), 256);
    try {
      validateDbWorkspaceId(workspaceId);
      const st = dbTimeTravelStore();
      const rows = checkpointId
        ? st.forCheckpoint(checkpointId).filter((m) => m.workspaceId === workspaceId)
        : st.list(workspaceId);
      ctx.json(res, 200, { workspaceId, snapshots: rows.map(summarizeDbSnapshot) });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // POST /api/db-time-travel/restore-db — dev only, confirm required.
  if (method === 'POST' && rest === '/restore-db') {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    const checkpointId = strOf(body['checkpointId'], 256);
    if (!workspaceId || !checkpointId) {
      ctx.json(res, 400, { error: 'workspaceId and checkpointId are required', code: 'DB_BAD_REQUEST' });
      return true;
    }
    try {
      validateDbWorkspaceId(workspaceId);
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      const r = restoreDbFromSnapshot(dbTimeTravelStore(), {
        workspaceId,
        workspacePath,
        checkpointId,
        confirm: body['confirm'],
      });
      ctx.audit.record('human', 'DB_RESTORED', 'db-snapshot', checkpointId, {
        workspaceId,
        relPath: r.relPath,
        size: r.size,
        sha256: r.sha256,
        preRestoreId: r.preRestore?.id ?? null,
      });
      ctx.json(res, 200, {
        restored: true,
        checkpointId: r.checkpointId,
        relPath: r.relPath,
        size: r.size,
        sha256: r.sha256,
        preRestore: r.preRestore ? summarizeDbSnapshot(r.preRestore) : null,
      });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  // POST /api/db-time-travel/promote — the only prod write path.
  if (method === 'POST' && rest === '/promote') {
    const body = await ctx.readBody(req);
    const workspaceId = strOf(body['workspaceId'], 64);
    const checkpointId = strOf(body['checkpointId'], 256);
    if (!workspaceId || !checkpointId) {
      ctx.json(res, 400, { error: 'workspaceId and checkpointId are required', code: 'DB_BAD_REQUEST' });
      return true;
    }
    try {
      validateDbWorkspaceId(workspaceId);
      const workspacePath = resolveWorkspacePath(body['workspacePath']);
      const r = promoteDbToProd(dbTimeTravelStore(), {
        workspaceId,
        workspacePath,
        checkpointId,
        confirm: body['confirm'],
      });
      ctx.audit.record('human', 'DB_PROMOTE', 'db-snapshot', checkpointId, {
        workspaceId,
        prodRelPath: r.prodRelPath,
        size: r.size,
        sha256: r.sha256,
        prePromoteId: r.prePromote?.id ?? null,
      });
      ctx.json(res, 200, {
        promoted: true,
        checkpointId: r.checkpointId,
        prodRelPath: r.prodRelPath,
        size: r.size,
        sha256: r.sha256,
        prePromote: r.prePromote ? summarizeDbSnapshot(r.prePromote) : null,
      });
    } catch (e) {
      const eb = toErrorBody(e);
      ctx.json(res, eb.status, eb.body);
    }
    return true;
  }

  return false;
}
