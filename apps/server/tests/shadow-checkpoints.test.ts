/**
 * Shadow git checkpoint unit tests (deterministic, real git CLI).
 *
 * Imports ../src/shadow-checkpoints.ts directly: the module uses node
 * builtins only, so it resolves under node's type-stripping ESM loader.
 *
 * Covers: sidecar creation, snapshot/commit stats, empty snapshots,
 * task-scoped diff, big-file + symlink skip policy, restore with
 * pre-restore backup (reversibility), untracked-after left in place,
 * path jail, workspace-id validation.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/shadow-checkpoints.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ShadowCheckpointError,
  ShadowCheckpointStore,
  createShadowCheckpoint,
  diffShadowCheckpoints,
  maxShadowFileBytes,
  restoreShadowCheckpoint,
  resolveWorkspacePath,
  sidecarPath,
  taskDiffRange,
  validateWorkspaceId,
} from '../src/shadow-checkpoints.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-shadow-'));
  const dataDir = path.join(root, 'data');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  process.env.FACTORY_SHADOW_ROOTS = root;
  delete process.env.AI_FACTORY_SHADOW_FILE;
  const store = new ShadowCheckpointStore(path.join(dataDir, 'shadow-checkpoints.json'));
  return { root, dataDir, ws, store };
}

function write(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

test('first snapshot commits files with stats', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'hello\n');
  write(ws, 'sub/b.txt', 'world\n');
  const cp = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'init' });
  assert.equal(cp.workspaceId, 'ws1');
  assert.equal(cp.empty, false);
  assert.equal(cp.fileCount, 2);
  assert.ok(cp.additions >= 2, `additions=${cp.additions}`);
  assert.equal(cp.parentSha, null);
  assert.ok(/^[0-9a-f]{40}$/.test(cp.sha));
  assert.ok(fs.existsSync(path.join(sidecarPath('ws1'), 'HEAD')));
  assert.deepEqual(store.list('ws1').map((c) => c.id), [cp.id]);
});

test('second snapshot is empty when nothing changed', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'hello\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  const c2 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'noop' });
  assert.equal(c2.empty, true);
  assert.equal(c2.sha, c1.sha);
  assert.equal(c2.fileCount, 0);
});

test('modified file produces diff with stats', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'one\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  write(ws, 'a.txt', 'one\ntwo\n');
  const c2 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  assert.equal(c2.parentSha, c1.sha);
  const d = diffShadowCheckpoints(store, 'ws1', c1.sha, c2.sha);
  assert.equal(d.files.length, 1);
  assert.equal(d.files[0].path, 'a.txt');
  assert.equal(d.files[0].additions, 1);
  assert.ok(d.diff.includes('+two'));
  assert.equal(d.truncated, false);
});

test('task-scoped diff spans only that task', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'v0\n');
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, taskId: 't1', label: 't1 start' });
  write(ws, 'a.txt', 'v1\n');
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, taskId: 't1', label: 't1 work' });
  write(ws, 'b.txt', 'other task\n');
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, taskId: 't2', label: 't2 work' });
  const range = taskDiffRange(store, 'ws1', 't1');
  assert.ok(range);
  assert.equal(range!.checkpoints.length, 2);
  const d = diffShadowCheckpoints(store, 'ws1', range!.base, range!.tip);
  assert.deepEqual(d.files.map((f) => f.path), ['a.txt']);
  assert.equal(taskDiffRange(store, 'ws1', 'nope'), null);
});

test('files over the cap are skipped and listed', () => {
  const { ws, store } = setup();
  process.env.FACTORY_SHADOW_MAX_FILE_BYTES = '10';
  try {
    assert.equal(maxShadowFileBytes(), 10);
    write(ws, 'small.txt', 'ok\n');
    write(ws, 'big.bin', '0123456789ABCDEF');
    const cp = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
    assert.equal(cp.skippedTotal, 1);
    assert.equal(cp.skipped[0].path, 'big.bin');
    assert.equal(cp.skipped[0].reason, 'too-large');
    assert.equal(cp.fileCount, 1);
  } finally {
    delete process.env.FACTORY_SHADOW_MAX_FILE_BYTES;
  }
});

test('symlinks are skipped, never followed', () => {
  const { ws, store } = setup();
  write(ws, 'real.txt', 'data\n');
  fs.symlinkSync(path.join(ws, 'real.txt'), path.join(ws, 'link.txt'));
  const cp = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  assert.ok(cp.skipped.some((s) => s.path === 'link.txt' && s.reason === 'symlink'));
});

test('restore brings content back and takes a reversible backup', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'v1\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'good' });
  write(ws, 'a.txt', 'v2-broken\n');
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'bad' });
  // Unsnapshotted change on top: the pre-restore backup must capture this,
  // because no existing checkpoint holds it.
  write(ws, 'a.txt', 'v3-uncommitted\n');

  const r = restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c1.id });
  assert.equal(r.restoredId, c1.id);
  assert.ok(r.backup, 'pre-restore backup must exist when workspace has unsnapshotted changes');
  assert.equal(r.backup!.trigger, 'pre-restore');
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');

  // Undo of the undo: restoring the backup returns to v3.
  const r2 = restoreShadowCheckpoint(store, {
    workspaceId: 'ws1',
    workspacePath: ws,
    checkpointId: r.backup!.id,
  });
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v3-uncommitted\n');
  assert.ok(r2.backup, 'second undo is also reversible');
});

test('restore from a state matching the last checkpoint needs no backup', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'v1\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'good' });
  write(ws, 'a.txt', 'v2\n');
  const c2 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'bad' });
  // Workspace == last checkpoint: the 'bad' checkpoint itself is the
  // reversible anchor, so no redundant backup is recorded.
  const r = restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c1.id });
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');
  const r2 = restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c2.id });
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v2\n');
  // After the first restore the workspace (v1) differs from the sidecar
  // HEAD (v2), so this undo correctly records a backup of v1.
  assert.ok(r2.backup, 'backup of the v1 state must exist');
  assert.equal(r2.backup!.label.includes('pre-restore'), true);
});

test('files created after the checkpoint are left in place on restore', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'v1\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  write(ws, 'a.txt', 'v2\n');
  write(ws, 'new-after.txt', 'brand new\n');
  const r = restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c1.id });
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');
  assert.ok(fs.existsSync(path.join(ws, 'new-after.txt')), 'never-snapshotted file must survive undo');
  assert.ok(r.leftInPlace.includes('new-after.txt'));
});

test('restore with no changes takes no backup', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'v1\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  const r = restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c1.id });
  assert.equal(r.backup, null);
});

test('deleted files are restored by undo', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'keep\n');
  write(ws, 'doomed.txt', 'will be deleted\n');
  const c1 = createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  fs.rmSync(path.join(ws, 'doomed.txt'));
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, label: 'deleted one' });
  restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: c1.id });
  assert.equal(fs.readFileSync(path.join(ws, 'doomed.txt'), 'utf8'), 'will be deleted\n');
});

test('path jail rejects escapes and bad ids', () => {
  const { ws, store } = setup();
  assert.throws(
    () => resolveWorkspacePath('/etc'),
    (e: unknown) => e instanceof ShadowCheckpointError && (e as ShadowCheckpointError).code === 'SHADOW_PATH_ESCAPE',
  );
  assert.throws(() => validateWorkspaceId('../evil'), /workspaceId/);
  assert.throws(() => validateWorkspaceId(''), /workspaceId/);
  assert.throws(
    () => createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: '/etc' }),
    (e: unknown) => e instanceof ShadowCheckpointError,
  );
  assert.ok(resolveWorkspacePath(ws).length > 0);
});

test('unknown checkpoint restore is 404-shaped', () => {
  const { ws, store } = setup();
  write(ws, 'a.txt', 'x\n');
  createShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws });
  assert.throws(
    () => restoreShadowCheckpoint(store, { workspaceId: 'ws1', workspacePath: ws, checkpointId: 'scp_nope' }),
    (e: unknown) => e instanceof ShadowCheckpointError && (e as ShadowCheckpointError).code === 'SHADOW_NOT_FOUND',
  );
});

test('config round-trips and matches by path', () => {
  const { ws, store } = setup();
  assert.equal(store.config('ws1'), null);
  store.setConfig({
    workspaceId: 'ws1',
    workspacePath: ws,
    autoOnToolUse: true,
    autoOnRunStart: false,
    updatedAt: new Date().toISOString(),
  });
  const cfg = store.config('ws1');
  assert.ok(cfg);
  assert.equal(cfg!.autoOnToolUse, true);
  assert.deepEqual(store.configsForPath(ws).map((c) => c.workspaceId), ['ws1']);
  assert.deepEqual(store.configsForPath('/nonexistent'), []);
});
