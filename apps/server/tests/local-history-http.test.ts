/**
 * R3-T6 Local History HTTP surface.
 *
 * Boots ../dist/index.js with cwd = a temp workspace root (so
 * AI_FACTORY_DATA_DIR can also be pointed at a temp dir) and verifies
 * the save→snapshot hook plus the history list/snapshot/restore routes.
 *
 * Requires the workspace build. Run via npm run test:server.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let child: ChildProcess | null = null;
let port = 0;
let workRoot = '';

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

after(() => {
  child?.kill('SIGKILL');
});

await (async () => {
  workRoot = mkdtempSync(join(homedir(), 'lh-http-ws-'));
  port = 24000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [serverMain], {
    cwd: workRoot,
    env: {
      ...process.env,
      PORT: String(port),
      FACTORY_SECRETS_DIR: join(workRoot, 'secrets-test'),
      AI_FACTORY_DATA_DIR: join(workRoot, 'lh-data'),
      TMPDIR: tmpdir(),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not boot');
    await new Promise((r) => setTimeout(r, 200));
  }
})();

describe('R3-T6 local history HTTP surface', () => {
  it('POST /api/file reports an ok localHistory snapshot', async () => {
    const r = await api('POST', '/api/file', { path: 'note.txt', content: 'v1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.localHistory.status, 'ok');
    assert.ok(r.json.localHistory.id);
  });

  it('three saves produce three listed snapshots, newest first', async () => {
    await api('POST', '/api/file', { path: 'note.txt', content: 'v2' });
    await api('POST', '/api/file', { path: 'note.txt', content: 'v3' });
    const r = await api('GET', '/api/file/history?path=note.txt');
    assert.equal(r.status, 200);
    assert.equal(r.json.snapshots.length, 3);
    assert.ok(r.json.snapshots[0].id > r.json.snapshots[1].id);
    assert.equal(r.json.snapshots[0].kind, 'save');
  });

  it('identical save is skipped-unchanged and adds no snapshot', async () => {
    const w = await api('POST', '/api/file', { path: 'note.txt', content: 'v3' });
    assert.equal(w.json.localHistory.status, 'skipped-unchanged');
    const r = await api('GET', '/api/file/history?path=note.txt');
    assert.equal(r.json.snapshots.length, 3);
  });

  it('a single snapshot can be read back', async () => {
    const list = await api('GET', '/api/file/history?path=note.txt');
    const oldest = list.json.snapshots[list.json.snapshots.length - 1];
    const r = await api('GET', `/api/file/history/snapshot?path=note.txt&id=${encodeURIComponent(oldest.id)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.content, 'v1');
  });

  it('restore rewrites the file and snapshots the pre-restore content', async () => {
    const w = await api('POST', '/api/file', { path: 'note.txt', content: 'v4' });
    assert.equal(w.json.localHistory.status, 'ok');
    const list = await api('GET', '/api/file/history?path=note.txt');
    const oldest = list.json.snapshots[list.json.snapshots.length - 1];
    assert.equal(oldest.kind, 'save');
    const r = await api('POST', '/api/file/history/restore', { path: 'note.txt', id: oldest.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.restoredFrom, oldest.id);
    // The pre-restore snapshot captures the current file content ('v4'),
    // which is already the latest snapshot — so it is deduped
    // (skipped-unchanged). The restore stays undoable via that snapshot.
    assert.equal(r.json.preRestore.status, 'skipped-unchanged');
    const f = await api('GET', '/api/file?path=note.txt');
    assert.equal(f.json.content, 'v1');
    const after = await api('GET', '/api/file/history?path=note.txt');
    assert.equal(after.json.snapshots.length, 4);
    assert.equal(after.json.snapshots[0].kind, 'save');
  });

  it('pre-restore snapshot is taken when current content diverges (external edit)', async () => {
    // Simulate a modification that bypassed /api/file (e.g. another tool):
    // the restore must still be undoable via a real pre-restore snapshot.
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(join(workRoot, 'note.txt'), 'external-edit');
    const list = await api('GET', '/api/file/history?path=note.txt');
    const oldest = list.json.snapshots[list.json.snapshots.length - 1];
    const r = await api('POST', '/api/file/history/restore', { path: 'note.txt', id: oldest.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.preRestore.status, 'ok');
    assert.ok(r.json.preRestore.id);
    const snap = await api(
      'GET',
      `/api/file/history/snapshot?path=note.txt&id=${encodeURIComponent(r.json.preRestore.id)}`,
    );
    assert.equal(snap.json.content, 'external-edit');
  });

  it('unknown snapshot id is 404 on snapshot and restore', async () => {
    const s = await api('GET', '/api/file/history/snapshot?path=note.txt&id=1-000000-save.snap');
    assert.equal(s.status, 404);
    const r = await api('POST', '/api/file/history/restore', { path: 'note.txt', id: '1-000000-save.snap' });
    assert.equal(r.status, 404);
  });

  it('restore requires path and id', async () => {
    const r = await api('POST', '/api/file/history/restore', { path: 'note.txt' });
    assert.equal(r.status, 400);
  });

  it('path traversal stays refused on the history routes', async () => {
    const r = await api('GET', '/api/file/history?path=../escape.txt');
    assert.equal(r.status, 403);
  });
});
