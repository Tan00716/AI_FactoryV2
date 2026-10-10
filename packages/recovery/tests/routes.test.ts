import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  registerRecoveryRoutes,
  SnapshotStore,
  type RecoveryRequest,
  type RecoveryRouter,
} from '../src/index';
import { tempDir, writeTree, cleanup } from './helpers';

interface Registered {
  path: string;
  handler: (req: RecoveryRequest) => Promise<unknown> | unknown;
}

function fakeRouter(): { router: RecoveryRouter; routes: Registered[] } {
  const routes: Registered[] = [];
  return {
    routes,
    router: { post: (path, handler) => routes.push({ path, handler }) },
  };
}

function match(routes: Registered[], path: string, params: Record<string, string> = {}) {
  for (const r of routes) {
    const pattern = r.path.replace(/:[^/]+/g, '([^/]+)');
    const m = new RegExp(`^${pattern}$`).exec(path);
    if (m) {
      const names = [...r.path.matchAll(/:([^/]+)/g)].map((x) => x[1] as string);
      const merged = { ...params };
      names.forEach((n, i) => (merged[n] = m[i + 1] as string));
      return { handler: r.handler, params: merged };
    }
  }
  return null;
}

async function post(
  routes: Registered[],
  path: string,
  body: Record<string, unknown> = {},
) {
  const hit = match(routes, path);
  assert.ok(hit, `no route matched ${path}`);
  return (await hit.handler({ params: hit.params, body })) as {
    status: number;
    [k: string]: unknown;
  };
}

describe('registerRecoveryRoutes', () => {
  it('registers the three recovery endpoints', () => {
    const { router, routes } = fakeRouter();
    registerRecoveryRoutes(router, { store: new SnapshotStore(tempDir('s-')) });
    const paths = routes.map((r) => r.path).sort();
    assert.deepEqual(paths, [
      '/api/recovery/classify',
      '/api/recovery/snapshots',
      '/api/recovery/snapshots/:id/restore',
    ]);
  });

  it('POST /api/recovery/classify returns the failure type', async () => {
    const { router, routes } = fakeRouter();
    registerRecoveryRoutes(router, { store: new SnapshotStore(tempDir('s-')) });
    const res = await post(routes, '/api/recovery/classify', {
      message: 'permission denied: EACCES',
    });
    assert.equal(res.status, 200);
    assert.equal((res.classification as { type: string }).type, 'PERMISSION_ERROR');
  });

  it('POST /api/recovery/classify rejects a missing message', async () => {
    const { router, routes } = fakeRouter();
    registerRecoveryRoutes(router, { store: new SnapshotStore(tempDir('s-')) });
    const res = await post(routes, '/api/recovery/classify', {});
    assert.equal(res.status, 400);
  });

  it('POST /api/recovery/snapshots takes a snapshot and audits it', async () => {
    const root = tempDir('s-');
    const ws = tempDir('ws-');
    writeTree(ws, { 'a.txt': 'data' });
    const audited: unknown[] = [];
    const { router, routes } = fakeRouter();
    try {
      registerRecoveryRoutes(router, {
        store: new SnapshotStore(root),
        audit: { record: (...a: unknown[]) => void audited.push(a) },
        actor: 'deployer',
      });
      const res = await post(routes, '/api/recovery/snapshots', {
        workspaceDir: ws,
        tag: 'before production deployment',
      });
      assert.equal(res.status, 201);
      const snap = res.snapshot as { id: string; sealed: boolean; files: unknown[] };
      assert.ok(snap.id);
      assert.equal(snap.sealed, true);
      assert.equal(snap.files.length, 1);
      assert.deepEqual(audited[0], [
        'deployer',
        'SNAPSHOT_TAKEN',
        'snapshot',
        snap.id,
        { workspaceDir: ws, files: 1, tag: 'before production deployment' },
      ]);
    } finally {
      cleanup(root, ws);
    }
  });

  it('POST /api/recovery/snapshots/:id/restore rolls back and returns the backup id', async () => {
    const root = tempDir('s-');
    const ws = tempDir('ws-');
    writeTree(ws, { 'app.js': 'v1' });
    const { router, routes } = fakeRouter();
    try {
      registerRecoveryRoutes(router, { store: new SnapshotStore(root) });
      const taken = await post(routes, '/api/recovery/snapshots', { workspaceDir: ws });
      const id = (taken.snapshot as { id: string }).id;
      writeFileSync(join(ws, 'app.js'), 'BROKEN');
      const res = await post(routes, `/api/recovery/snapshots/${id}/restore`, {});
      assert.equal(res.status, 200);
      assert.equal(res.restored, id);
      const backup = res.backupSnapshot as { id: string; tag: string };
      assert.ok(backup.id && backup.id !== id);
      assert.equal(backup.tag, `pre-restore:${id}`);
      assert.equal(readFileSync(join(ws, 'app.js'), 'utf8'), 'v1');
    } finally {
      cleanup(root, ws);
    }
  });

  it('restore of an unknown snapshot id → 404', async () => {
    const { router, routes } = fakeRouter();
    registerRecoveryRoutes(router, { store: new SnapshotStore(tempDir('s-')) });
    const res = await post(routes, '/api/recovery/snapshots/nope/restore', {});
    assert.equal(res.status, 404);
  });

  it('snapshot endpoint rejects a missing workspaceDir', async () => {
    const { router, routes } = fakeRouter();
    registerRecoveryRoutes(router, { store: new SnapshotStore(tempDir('s-')) });
    const res = await post(routes, '/api/recovery/snapshots', {});
    assert.equal(res.status, 400);
  });
});
