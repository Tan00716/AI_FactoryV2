/**
 * Recovery HTTP routes — spec §77–§78.
 *
 *  POST /api/recovery/snapshots            {workspaceDir, dbPath?, tag?} → take snapshot
 *  POST /api/recovery/snapshots/:id/restore {workspaceDir?} → restore (backs up current state first)
 *  POST /api/recovery/classify              {message, context?} → failure classification
 *
 * Style note: apps/server route modules export handleXxxRoutes(req, res, url,
 * ctx). This package cannot depend on the server (zero external deps), so it
 * exports registerRecoveryRoutes(router, deps) against a loose router
 * interface — any Express-like object with post(path, handler) works, and an
 * adapter to the handleXxxRoutes shape is one thin wrapper in apps/server.
 *
 *   // apps/server adapter sketch:
 *   const mini = { post: (p, h) => { if (req.method==='POST' && url.pathname===p) ... } };
 */

import { classifyFailure, type FailureContext } from './classify';
import { SnapshotStore } from './snapshot';

/** Loose router: only post() is required. */
export interface RecoveryRouter {
  post(
    path: string,
    handler: (req: RecoveryRequest) => Promise<unknown> | unknown,
  ): void;
}

export interface RecoveryRequest {
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Loose deps — everything optional. Defaults: a SnapshotStore rooted at
 * ./recovery-data (cwd), no audit.
 */
export interface RecoveryRouteDeps {
  store?: SnapshotStore;
  snapshotRoot?: string;
  audit?: {
    record(
      actor: string,
      action: string,
      entityType: string,
      entityId: string,
      details?: Record<string, unknown>,
    ): unknown;
  };
  actor?: string;
}

export function registerRecoveryRoutes(
  router: RecoveryRouter,
  deps: RecoveryRouteDeps = {},
): void {
  const store = deps.store ?? new SnapshotStore(deps.snapshotRoot ?? './recovery-data');
  const audit = deps.audit;
  const actor = deps.actor ?? 'system';

  // POST /api/recovery/snapshots  {workspaceDir, dbPath?, tag?}
  router.post('/api/recovery/snapshots', (req) => {
    const workspaceDir = req.body['workspaceDir'] as string | undefined;
    if (!workspaceDir) {
      return { status: 400, error: 'workspaceDir is required' };
    }
    const snap = store.take(workspaceDir, {
      dbPath: req.body['dbPath'] as string | undefined,
      tag: req.body['tag'] as string | undefined,
    });
    audit?.record(actor, 'SNAPSHOT_TAKEN', 'snapshot', snap.id, {
      workspaceDir: snap.workspaceDir,
      files: snap.files.length,
      tag: snap.tag,
    });
    return { status: 201, snapshot: snap };
  });

  // POST /api/recovery/snapshots/:id/restore  {workspaceDir?}
  router.post('/api/recovery/snapshots/:id/restore', (req) => {
    const id = req.params['id'];
    if (!id || !store.get(id)) {
      return { status: 404, error: `snapshot ${id ?? '(missing id)'} not found` };
    }
    const backup = store.restore(
      id,
      req.body['workspaceDir'] as string | undefined,
    );
    audit?.record(actor, 'SNAPSHOT_RESTORED', 'snapshot', id, {
      backupSnapshotId: backup.id,
      workspaceDir: backup.workspaceDir,
    });
    return {
      status: 200,
      restored: id,
      backupSnapshot: { id: backup.id, tag: backup.tag },
    };
  });

  // POST /api/recovery/classify  {message, context?}
  router.post('/api/recovery/classify', (req) => {
    const message = req.body['message'] as string | undefined;
    if (!message) {
      return { status: 400, error: 'message is required' };
    }
    const result = classifyFailure({
      message,
      context: req.body['context'] as FailureContext | undefined,
    });
    return { status: 200, classification: result };
  });
}
