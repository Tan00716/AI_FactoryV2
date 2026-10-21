/**
 * Local History HTTP routes (R3-T6).
 *
 *  GET  /api/file/history?path=<rel>                → list snapshots of a file
 *  GET  /api/file/history/snapshot?path=<rel>&id=<id> → read one snapshot's content
 *  POST /api/file/history/restore {path, id}        → restore a snapshot
 *       (the current content is snapshotted as `pre-restore` first, so a
 *       restore is itself undoable; the action is audited)
 *
 * Snapshots are taken automatically on POST /api/file (see routes/files.ts);
 * these routes are the read/restore side. Path confinement and the
 * control-plane guard are shared with routes/files.ts.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import { resolveWorkspacePath } from './files';
import {
  listSnapshots,
  readSnapshot,
  snapshotOnSave,
  type SnapshotRecord,
} from '../local-history';

const WORKSPACE_ROOT = resolve(process.cwd());

export async function handleLocalHistoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GET /api/file/history?path=<rel>
  if (path === '/api/file/history' && method === 'GET') {
    let file: string;
    try {
      file = resolveWorkspacePath(url.searchParams.get('path'));
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    const rel = url.searchParams.get('path') ?? '';
    ctx.json(res, 200, { path: rel, snapshots: listSnapshots(WORKSPACE_ROOT, rel) });
    return true;
  }

  // GET /api/file/history/snapshot?path=<rel>&id=<id>
  if (path === '/api/file/history/snapshot' && method === 'GET') {
    let rel: string;
    try {
      resolveWorkspacePath(url.searchParams.get('path'));
      rel = url.searchParams.get('path') ?? '';
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    const id = url.searchParams.get('id') ?? '';
    const content = readSnapshot(WORKSPACE_ROOT, rel, id);
    if (content === null) {
      ctx.json(res, 404, { error: `snapshot not found: ${id}` });
      return true;
    }
    ctx.json(res, 200, { path: rel, id, content });
    return true;
  }

  // POST /api/file/history/restore  {path, id, actor?}
  if (path === '/api/file/history/restore' && method === 'POST') {
    const body = await ctx.readBody(req);
    const rel = body['path'] as string | undefined;
    const id = body['id'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    if (!rel || !id) {
      ctx.json(res, 400, { error: 'path and id are required' });
      return true;
    }
    let file: string;
    try {
      file = resolveWorkspacePath(rel);
    } catch (err) {
      ctx.json(res, 403, { error: (err as Error).message });
      return true;
    }
    const content = readSnapshot(WORKSPACE_ROOT, rel, id);
    if (content === null) {
      ctx.json(res, 404, { error: `snapshot not found: ${id}` });
      return true;
    }
    // Snapshot the current content first — a restore must be undoable.
    // Best-effort like the save hook: a failed pre-restore snapshot is
    // reported, not a blocker.
    let preRestore: SnapshotRecord | null = null;
    if (existsSync(file) && statSync(file).isFile()) {
      try {
        preRestore = snapshotOnSave(WORKSPACE_ROOT, rel, readFileSync(file, 'utf8'), 'pre-restore');
      } catch (err) {
        preRestore = { status: 'skipped-error', id: null, reason: (err as Error).message, pruned: 0 };
      }
    }
    writeFileSync(file, content, 'utf8');
    ctx.audit.record(actor, 'LOCAL_HISTORY_RESTORE', 'file', rel, {
      snapshotId: id,
      preRestoreStatus: preRestore ? preRestore.status : 'no-previous-file',
    });
    ctx.json(res, 200, { ok: true, path: rel, restoredFrom: id, preRestore });
    return true;
  }

  return false;
}
